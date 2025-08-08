// Copyright (c) 2023, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import express from 'express';
import _ from 'underscore';

import {isString, unique} from '../../shared/common-utils.js';
import {CompilerInfo} from '../../types/compiler.interfaces.js';
import {Language, LanguageKey} from '../../types/languages.interfaces.js';
import {assert, unwrap} from '../assert.js';
import {ClientStateNormalizer} from '../clientstate-normalizer.js';
import {CompilationEnvironment} from '../compilation-env.js';
import {IExecutionEnvironment} from '../execution/execution-env.interfaces.js';
import {LocalExecutionEnvironment} from '../execution/index.js';
import {logger} from '../logger.js';
import {ClientOptionsHandler} from '../options-handler.js';
import {PropertyGetter} from '../properties.interfaces.js';
import {SentryCapture} from '../sentry.js';
import {BaseShortener, getShortenerTypeByKey} from '../shortener/index.js';
import {StorageBase} from '../storage/index.js';

import {CompileHandler} from './compile.js';

function methodNotAllowed(req: express.Request, res: express.Response) {
    res.status(405).send('Method Not Allowed');
}

export class ApiHandler {
    public compilers: CompilerInfo[] = [];
    public languages: Partial<Record<LanguageKey, Language>> = {};
    private usedLangIds: LanguageKey[] = [];
    private options: ClientOptionsHandler | null = null;
    public readonly handle: express.Router;
    public readonly shortener: BaseShortener;
    private release = {
        gitReleaseName: '',
        releaseBuildNumber: '',
    };
    private readonly compilationEnvironment: CompilationEnvironment;

    constructor(
        compileHandler: CompileHandler,
        ceProps: PropertyGetter,
        private readonly storageHandler: StorageBase,
        urlShortenService: string,
        compilationEnvironment: CompilationEnvironment,
    ) {
        this.handle = express.Router();
        this.compilationEnvironment = compilationEnvironment;
        const cacheHeader = `public, max-age=${ceProps('apiMaxAgeSecs', 24 * 60 * 60)}`;
        this.handle.use((req, res, next) => {
            res.header({
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
                'Cache-Control': cacheHeader,
            });
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
            } else {
                next();
            }
        });
        this.handle.route('/compilers').get(this.handleCompilers.bind(this)).all(methodNotAllowed);

        this.handle.route('/compilers/:language').get(this.handleCompilers.bind(this)).all(methodNotAllowed);

        this.handle.route('/languages').get(this.handleLanguages.bind(this)).all(methodNotAllowed);

        this.handle.route('/libraries/:language').get(this.handleLangLibraries.bind(this)).all(methodNotAllowed);

        this.handle.route('/libraries').get(this.handleAllLibraries.bind(this)).all(methodNotAllowed);

        this.handle
            .route('/asm/:opcode')
            .get((req, res) => res.redirect(`amd64/${req.params.opcode}`))
            .all(methodNotAllowed);

        const maxUploadSize = ceProps('maxUploadSize', '1mb');
        const textParser = express.text({limit: ceProps('bodyParserLimit', maxUploadSize), type: () => true});

        this.handle
            .route('/compiler/:compiler/compile')
            .post(textParser, compileHandler.handle.bind(compileHandler))
            .all(methodNotAllowed);
        this.handle
            .route('/compiler/:compiler/cmake')
            .post(compileHandler.handleCmake.bind(compileHandler))
            .all(methodNotAllowed);

        if (this.compilationEnvironment.ceProps('localexecutionEndpoint', false)) {
            this.handle.route('/localexecution/:hash').post(this.handleLocalExecution.bind(this)).all(methodNotAllowed);
        }

        this.handle
            .route('/popularArguments/:compiler')
            .post(compileHandler.handlePopularArguments.bind(compileHandler))
            .get(compileHandler.handlePopularArguments.bind(compileHandler))
            .all(methodNotAllowed);
        this.handle
            .route('/optimizationArguments/:compiler')
            .post(compileHandler.handleOptimizationArguments.bind(compileHandler))
            .get(compileHandler.handleOptimizationArguments.bind(compileHandler))
            .all(methodNotAllowed);
        this.handle.route('/shortlinkinfo/:id').get(this.shortlinkInfoHandler.bind(this)).all(methodNotAllowed);

        const shortenerType = getShortenerTypeByKey(urlShortenService);
        this.shortener = new shortenerType(storageHandler);
        this.handle.route('/shortener').post(this.shortener.handle.bind(this.shortener)).all(methodNotAllowed);

        this.handle.route('/version').get(this.handleReleaseName.bind(this)).all(methodNotAllowed);
        this.handle.route('/releaseBuild').get(this.handleReleaseBuild.bind(this)).all(methodNotAllowed);

        // ML model proxy endpoint
        this.handle
            .route('/ml-model/invocations')
            .post(textParser, this.handleMLModelCall.bind(this))
            .all(methodNotAllowed);

        // Let's not document this one, eh?
        this.handle.route('/forceServerError').get((req, res) => {
            logger.error(`Forced server error from ${req.ip}`);
            throw new Error('Forced server error');
        });
    }

    shortlinkInfoHandler(req: express.Request, res: express.Response, next: express.NextFunction) {
        const id = req.params.id;
        this.storageHandler
            .expandId(id)
            .then(result => {
                const config = JSON.parse(result.config);

                if (result.created) res.header('Link-Created', result.created.toUTCString());

                if (config.content) {
                    const normalizer = new ClientStateNormalizer();
                    normalizer.fromGoldenLayout(config);

                    res.send(normalizer.normalized);
                } else {
                    res.send(config);
                }
            })
            .catch(err => {
                logger.warn(`Exception thrown when expanding ${id}: `, err);
                logger.warn('Exception value:', err);
                SentryCapture(err, 'shortlinkInfoHandler');
                next({
                    statusCode: 404,
                    message: `ID "${id}" could not be found`,
                });
            });
    }

    handleLanguages(req: express.Request, res: express.Response) {
        const availableLanguages = this.usedLangIds.map(val => {
            const lang = this.languages[val];
            const newLangObj: Language = Object.assign({}, lang);
            if (this.options) {
                newLangObj.defaultCompiler = this.options.options.defaultCompiler[unwrap(lang).id];
            }
            return newLangObj;
        });

        this.outputList(availableLanguages, 'Id', req, res);
    }

    filterCompilerProperties(list: CompilerInfo[] | Language[], selectedFields: string[]) {
        return list.map(compiler => {
            return _.pick(compiler, selectedFields);
        });
    }

    outputList(list: CompilerInfo[] | Language[], title: string, req: express.Request, res: express.Response) {
        if (req.accepts(['text', 'json']) === 'json') {
            if (req.query.fields === 'all') {
                res.send(list);
            } else {
                const defaultfields = [
                    'id',
                    'name',
                    'lang',
                    'compilerType',
                    'semver',
                    'extensions',
                    'monaco',
                    'instructionSet',
                ];
                if (req.query.fields) {
                    assert(isString(req.query.fields));
                    const filteredList = this.filterCompilerProperties(list, req.query.fields.split(','));
                    res.send(filteredList);
                } else {
                    const filteredList = this.filterCompilerProperties(list, defaultfields);
                    res.send(filteredList);
                }
            }
            return;
        }

        const maxLength = Math.max(
            ...list
                .map(item => item.id)
                .concat([title])
                .map(item => item.length),
        );
        const header = title.padEnd(maxLength, ' ') + ' | Name\n';
        const body = list.map(lang => lang.id.padEnd(maxLength, ' ') + ' | ' + lang.name).join('\n');
        res.set('Content-Type', 'text/plain');
        res.send(header + body);
    }

    getLibrariesAsArray(languageId: LanguageKey) {
        const libsForLanguageObj = unwrap(this.options).options.libs[languageId];
        if (!libsForLanguageObj) return [];

        return Object.keys(libsForLanguageObj).map(key => {
            const language = libsForLanguageObj[key];
            const versionArr = Object.keys(language.versions).map(key => {
                return {
                    ...language.versions[key],
                    id: key,
                };
            });

            return {
                id: key,
                name: language.name,
                description: language.description,
                url: language.url,
                versions: versionArr,
            };
        });
    }

    handleLangLibraries(req: express.Request, res: express.Response, next: express.NextFunction) {
        if (this.options) {
            if (req.params.language) {
                res.send(this.getLibrariesAsArray(req.params.language as LanguageKey));
            } else {
                next({
                    statusCode: 404,
                    message: 'Language is required',
                });
            }
        } else {
            next({
                statusCode: 500,
                message: 'Internal error',
            });
        }
    }

    async handleLocalExecution(req: express.Request, res: express.Response, next: express.NextFunction) {
        if (!req.params.hash) {
            next({statusCode: 404, message: 'No hash supplied'});
            return;
        }

        if (!req.body.ExecutionParams) {
            next({statusCode: 404, message: 'No ExecutionParams'});
            return;
        }

        try {
            const env: IExecutionEnvironment = new LocalExecutionEnvironment(this.compilationEnvironment);
            await env.downloadExecutablePackage(req.params.hash);
            const execResult = await env.execute(req.body.ExecutionParams);
            logger.debug('execResult', execResult);
            res.send(execResult);
        } catch (e) {
            logger.error(e);
            next({statusCode: 500, message: 'Internal error'});
        }
    }

    handleAllLibraries(req: express.Request, res: express.Response, next: express.NextFunction) {
        if (this.options) {
            res.send(this.options.options.libs);
        } else {
            next({
                statusCode: 500,
                message: 'Internal error',
            });
        }
    }

    handleCompilers(req: express.Request, res: express.Response) {
        let filteredCompilers = this.compilers;
        if (req.params.language) {
            filteredCompilers = this.compilers.filter(compiler => compiler.lang === req.params.language);
        }

        this.outputList(filteredCompilers, 'Compiler Name', req, res);
    }

    handleReleaseName(req: express.Request, res: express.Response) {
        res.send(this.release.gitReleaseName);
    }

    handleReleaseBuild(req: express.Request, res: express.Response) {
        res.send(this.release.releaseBuildNumber);
    }

    async handleMLModelCall(req: express.Request, res: express.Response) {
        try {
            // The request body should be the assembly text
            const asmText = req.body;

            // Split assembly into functions based on lines ending with ":"
            const lines = asmText.split('\n');
            const functions: string[] = [];
            const labelMap: Record<number, string> = {};
            let currentFunction: string[] = [];
            let currentId = 1;

            for (const line of lines) {
                const trimmedLine = line.trim();

                if (trimmedLine.endsWith(':')) {
                    // This is a function label - start a new function
                    if (currentFunction.length > 0) {
                        // Save the previous function
                        functions.push(currentFunction.join('\n'));
                        currentId++;
                    }
                    // Store the label in our map and start new function
                    labelMap[currentId] = trimmedLine;
                    currentFunction = [];
                } else if (trimmedLine) {
                    // Add non-empty lines to current function
                    currentFunction.push(line);
                }
            }

            // Don't forget the last function
            if (currentFunction.length > 0) {
                functions.push(currentFunction.join('\n'));
            }

            // Generate CSV with id,r.asm format
            const csvRows = ['id,r.asm'];
            functions.forEach((func, index) => {
                const id = index + 1;
                const escapedAsm = func.replace(/"/g, '""');
                csvRows.push(`${id},"${escapedAsm}"`);
            });

            const csvData = csvRows.join('\n');
            logger.debug('Label map:', labelMap);
            logger.debug('Calling ML model API with data:', csvData);

            // Make the request to the ML model endpoint
            const response = await fetch('http://10.10.3.12:8080/invocations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/csv',
                },
                body: csvData,
            });

            if (!response.ok) {
                throw new Error(`ML model API returned ${response.status}: ${response.statusText}`);
            }

            const result = await response.arrayBuffer();
            console.log('ML model API response length:', result.byteLength);

            // Parse NumPy array format
            const parsedResult = this.parseNumpyArray(result);
            console.log('Parsed NumPy result:', parsedResult);

            // Return both the result and the label map for reference
            res.json({
                result: parsedResult,
                labelMap,
                functionCount: functions.length,
            });
        } catch (error) {
            logger.error('Error calling ML model API:', error);
            res.status(500).json({
                error: 'Failed to call ML model API',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    private parseNumpyArray(buffer: ArrayBuffer): any {
        try {
            const view = new Uint8Array(buffer);

            // Check for NumPy magic number
            const magic = String.fromCharCode(...view.slice(0, 6));
            if (magic !== '\x93NUMPY') {
                throw new Error('Not a valid NumPy array');
            }

            // Get version
            const majorVersion = view[6];
            const minorVersion = view[7];
            console.log(`NumPy version: ${majorVersion}.${minorVersion}`);

            // Get header length
            let headerLength: number;
            if (majorVersion === 1) {
                headerLength = view[8] | (view[9] << 8);
            } else {
                headerLength = view[8] | (view[9] << 8) | (view[10] << 16) | (view[11] << 24);
            }

            const headerStart = majorVersion === 1 ? 10 : 12;
            const headerEnd = headerStart + headerLength;

            // Parse header (Python dict format)
            const headerStr = String.fromCharCode(...view.slice(headerStart, headerEnd));
            console.log('NumPy header:', headerStr);

            // Parse the header string to extract shape and dtype
            const shapeMatch = headerStr.match(/'shape':\s*\(([^)]+)\)/);
            const dtypeMatch = headerStr.match(/'descr':\s*'([^']+)'/);
            const fortranMatch = headerStr.match(/'fortran_order':\s*(True|False)/);

            if (!shapeMatch || !dtypeMatch) {
                throw new Error('Could not parse NumPy header');
            }

            const shapeStr = shapeMatch[1];
            const dtype = dtypeMatch[1];
            const fortranOrder = fortranMatch ? fortranMatch[1] === 'True' : false;

            // Parse shape
            const shape = shapeStr
                .split(',')
                .map(s => Number.parseInt(s.trim()))
                .filter(n => !Number.isNaN(n));
            console.log('Shape:', shape, 'Dtype:', dtype, 'Fortran order:', fortranOrder);

            // Calculate total elements
            const totalElements = shape.reduce((a, b) => a * b, 1);

            // Parse data based on dtype
            const dataStart = headerEnd;
            const dataView = new DataView(buffer, dataStart);
            const result: number[] = [];

            // Handle different data types
            let bytesPerElement: number;
            let readFunction: (offset: number, littleEndian?: boolean) => number;

            if (dtype === '<f4') {
                // 32-bit float, little endian
                bytesPerElement = 4;
                readFunction = dataView.getFloat32.bind(dataView);
            } else if (dtype === '<f8') {
                // 64-bit float, little endian
                bytesPerElement = 8;
                readFunction = dataView.getFloat64.bind(dataView);
            } else if (dtype === '<i4') {
                // 32-bit int, little endian
                bytesPerElement = 4;
                readFunction = dataView.getInt32.bind(dataView);
            } else if (dtype === '<i8') {
                // 64-bit int, little endian
                bytesPerElement = 8;
                readFunction = (offset: number) => Number(dataView.getBigInt64(offset, true));
            } else {
                throw new Error(`Unsupported dtype: ${dtype}`);
            }

            // Read data
            for (let i = 0; i < totalElements; i++) {
                const offset = i * bytesPerElement;
                result.push(readFunction(offset, true));
            }

            // Reshape data according to shape
            const reshapedData = this.reshapeArray(result, shape);

            return {
                shape,
                dtype,
                data: reshapedData,
                fortranOrder,
            };
        } catch (error) {
            console.error('Error parsing NumPy array:', error);
            // Return raw text as fallback
            const decoder = new TextDecoder();
            return {
                error: 'Failed to parse NumPy array',
                rawData: decoder.decode(buffer),
                message: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    private reshapeArray(flatArray: number[], shape: number[]): any {
        if (shape.length === 1) {
            return flatArray;
        }

        if (shape.length === 2) {
            const [rows, cols] = shape;
            const result: number[][] = [];
            for (let i = 0; i < rows; i++) {
                const row: number[] = [];
                for (let j = 0; j < cols; j++) {
                    row.push(flatArray[i * cols + j]);
                }
                result.push(row);
            }
            return result;
        }

        // For higher dimensions, just return flat array with shape info
        return {
            flatData: flatArray,
            shape,
            note: 'Multidimensional array returned as flat data with shape info',
        };
    }

    setCompilers(compilers: CompilerInfo[]) {
        this.compilers = compilers;
        this.usedLangIds = unique(this.compilers.map(compiler => compiler.lang));
    }

    setLanguages(languages: Partial<Record<LanguageKey, Language>>) {
        this.languages = languages;
    }

    setOptions(options: ClientOptionsHandler) {
        this.options = options;
    }

    setReleaseInfo(gitReleaseName: string | undefined, releaseBuildNumber: string | undefined) {
        this.release = {
            gitReleaseName: gitReleaseName || '',
            releaseBuildNumber: releaseBuildNumber || '',
        };
    }
}
