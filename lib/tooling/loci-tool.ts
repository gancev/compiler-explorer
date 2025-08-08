// Copyright (c) 2025, Compiler Explorer Authors
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

import _ from 'underscore';

import {CompilationInfo} from '../../types/compilation/compilation.interfaces.js';
import type {ResultLine} from '../../types/resultline/resultline.interfaces.js';
import type {ToolResult} from '../../types/tool.interfaces.js';
import {logger} from '../logger.js';
import * as utils from '../utils.js';

import {BaseTool} from './base-tool.js';

// State management for tracking previous predictions
type FunctionPrediction = {
    std: number;
    execTime: number;
    timestamp: number;
    asmText: string;
};

type PredictionState = {
    [functionName: string]: FunctionPrediction;
};

export class LociTool extends BaseTool {
    private static predictionHistory: PredictionState = {};

    static get key() {
        return 'loci-tool';
    }

    constructor(toolInfo: any, env: any) {
        super(toolInfo, env);
        this.addOptionsToToolArgs = false;
    }

    private async callMLModelAPI(asmText: string): Promise<any> {
        try {
            // Make the API call to our server endpoint
            const response = await fetch('http://localhost:10240/api/ml-model/invocations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                },
                body: asmText,
            });

            if (!response.ok) {
                throw new Error(`API returned ${response.status}: ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            logger.error('Error calling ML model API:', error);
            throw error;
        }
    }

    // private calculatePercentageChange(current: number, previous: number): string {
    //     if (previous === 0) return 'N/A';
    //     const change = ((current - previous) / previous) * 100;
    //     const sign = change >= 0 ? '+' : '';
    //     return `${sign}${change.toFixed(1)}%`;
    // }

    private formatPerformanceChange(current: number, previous: number): string {
        if (previous === 0) return '';
        // Use the same rounding as execTimeText formatting to avoid false differences
        const roundedCurrent = Number.parseFloat(current.toFixed(0));
        const roundedPrevious = Number.parseFloat(previous.toFixed(0));

        if (roundedCurrent === roundedPrevious) {
            return ' ≈ (no change)';
        }

        const change = ((roundedCurrent - roundedPrevious) / roundedPrevious) * 100;
        if (change > 0) {
            return ` 🔴 (+${change.toFixed(1)}% slower)`;
        }
        if (change < 0) {
            return ` 🟢 (${change.toFixed(1)}% faster)`;
        }
        return '';
    }

    private updatePredictionHistory(functionName: string, std: number, execTime: number, asmText: string): void {
        LociTool.predictionHistory[functionName] = {
            std,
            execTime,
            timestamp: Date.now(),
            asmText,
        };
    }

    private getPreviousPrediction(functionName: string): FunctionPrediction | null {
        return LociTool.predictionHistory[functionName] || null;
    }

    private formatAssemblyDiff(currentAsm: string, previousAsm: string): string[] {
        if (!previousAsm || currentAsm === previousAsm) {
            return [];
        }

        const currentLines = currentAsm.split('\n');
        const previousLines = previousAsm.split('\n');

        // Side-by-side diff with tab separation
        const diffLines: string[] = [];
        const maxLines = Math.max(currentLines.length, previousLines.length);
        let hasChanges = false;

        // Header for side-by-side comparison
        diffLines.push('    📄 Assembly Changes:');
        diffLines.push('    Previous\t\t\t\t\t\t\t\t\t\tCurrent');
        diffLines.push('    --------\t\t\t\t\t\t\t\t\t\t-------');

        for (let i = 0; i < maxLines; i++) {
            const currentLine = (currentLines[i] || '').trim();
            const previousLine = (previousLines[i] || '').trim();

            if (currentLine !== previousLine) {
                hasChanges = true;

                // Pad lines to consistent width for better alignment
                const prevPadded = previousLine.padEnd(50);

                if (previousLine && !currentLine) {
                    // Line removed
                    diffLines.push(`  🔴 ${prevPadded}\t-`);
                } else if (!previousLine && currentLine) {
                    // Line added
                    diffLines.push(`  - \t\t\t\t\t🟢 ${currentLine}`);
                } else {
                    // Line changed
                    diffLines.push(`  🔴 ${prevPadded}\t🟢 ${currentLine}`);
                }
            } else if (currentLine && diffLines.length > 3 && diffLines.length < 13) {
                // Show context lines (same in both)
                const linePadded = currentLine.padEnd(50);
                diffLines.push(`    ${linePadded}\t  ${currentLine}`);
            }
        }

        if (!hasChanges) {
            return [];
        }

        return [
            ...diffLines.slice(0, 18), // Limit to first 18 lines (including headers)
            ...(diffLines.length > 18 ? ['    ... (diff truncated)'] : []),
        ];
    }

    private extractFunctionAssembly(parsedAsm: any, functionLabel: string, fullAsmText: string): string {
        // For now, return a portion of the full assembly text
        // This is a simplified approach - ideally we'd parse function boundaries
        // but that requires more complex analysis of the parsed ASM structure

        // Try to find function boundaries in the full text
        const lines = fullAsmText.split('\n');
        const functionStartPattern = new RegExp(`^${functionLabel}:?\\s*$`, 'i');
        let startIndex = -1;
        let endIndex = lines.length;

        // Find start of this function
        for (let i = 0; i < lines.length; i++) {
            if (functionStartPattern.test(lines[i].trim())) {
                startIndex = i;
                break;
            }
        }

        if (startIndex === -1) {
            // Fallback: return a hash of the function name with some assembly context
            const hash = functionLabel.split('').reduce((a, b) => {
                a = (a << 5) - a + b.charCodeAt(0);
                return a & a;
            }, 0);
            const startLine = Math.abs(hash) % Math.max(1, lines.length - 10);
            return lines.slice(startLine, startLine + 10).join('\n');
        }

        // Find end of this function (next function label, data section label, or significant gap)
        for (let i = startIndex + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            // Stop at any label ending with ':' - this includes both function labels and data section labels like .LC0:
            if (line.endsWith(':') && line !== functionLabel + ':') {
                endIndex = i;
                break;
            }
            // Stop at empty line followed by label-like pattern
            if (!line && i + 1 < lines.length) {
                const nextLine = lines[i + 1].trim();
                if (nextLine.endsWith(':')) {
                    endIndex = i;
                    break;
                }
            }
        }

        return lines.slice(startIndex, endIndex).join('\n');
    }

    private formatMLResults(data: any, parsedAsm: any, fullAsmText: string): ResultLine[] {
        const output: ResultLine[] = [];

        // Statistics for summary
        let improvedFunctions = 0;
        let degradedFunctions = 0;
        let unchangedFunctions = 0;

        // Header
        output.push({
            text: `🔍 LOCI Performance Analysis (${data.functionCount} ASM Block/ Functions)`,
        });
        output.push({
            text: '*Loop executions estimated based on a single execution path*',
        });
        output.push({text: ''});

        // Function analysis
        if (data.result?.data && data.labelMap) {
            output.push({text: '📊 Performance Predictions:'});
            output.push({text: ''});

            // Display each function with its predictions
            if (Array.isArray(data.result.data[0])) {
                // 2D array - each row corresponds to a function
                data.result.data.forEach((row: number[], i: number) => {
                    const functionId = (i + 1).toString();
                    const label = data.labelMap[functionId];
                    if (label) {
                        const cleanLabel = label.replace(':', '');
                        const currentStd = row[0] ? row[0] : 0;
                        const currentExecTime = row[1] ? row[1] : 0;

                        // Get previous prediction for comparison
                        const previousPrediction = this.getPreviousPrediction(cleanLabel);

                        // Format current values
                        // const stdText = currentStd.toFixed(4);
                        const execTimeText = currentExecTime.toFixed(0);

                        // Calculate performance changes
                        // const stdChange = previousPrediction ?
                        //     this.formatPerformanceChange(currentStd, previousPrediction.std) : '';
                        const execTimeChange = previousPrediction
                            ? this.formatPerformanceChange(currentExecTime, previousPrediction.execTime)
                            : '';

                        // Track performance statistics for summary
                        if (previousPrediction) {
                            // Use the same rounding as display logic to avoid inconsistencies
                            const roundedCurrent = Number.parseFloat(currentExecTime.toFixed(0));
                            const roundedPrevious = Number.parseFloat(previousPrediction.execTime.toFixed(0));

                            if (roundedCurrent === roundedPrevious) {
                                unchangedFunctions++;
                            } else {
                                const execTimeChangePercent =
                                    ((roundedCurrent - roundedPrevious) / roundedPrevious) * 100;
                                if (execTimeChangePercent < 0) {
                                    improvedFunctions++;
                                } else {
                                    degradedFunctions++;
                                }
                            }
                        }

                        // Extract function-specific assembly
                        const currentFunctionAsm = this.extractFunctionAssembly(parsedAsm, cleanLabel, fullAsmText);

                        // Update prediction history for next run
                        this.updatePredictionHistory(cleanLabel, currentStd, currentExecTime, currentFunctionAsm);

                        output.push({
                            text: ` ${cleanLabel.padEnd(25)}  ${`${execTimeText} ns`.padEnd(10)}${execTimeChange}`,
                        });

                        // Show assembly diff if there are performance changes and previous data exists
                        if (previousPrediction && execTimeChange && !execTimeChange.includes('no change')) {
                            const assemblyDiff = this.formatAssemblyDiff(
                                currentFunctionAsm,
                                previousPrediction.asmText,
                            );
                            assemblyDiff.forEach(diffLine => {
                                output.push({text: diffLine});
                            });
                        }
                        // output.push({
                        //     text: `    📈 Standard Deviation: ${stdText} ns${stdChange}`,
                        // });
                        // output.push({
                        //     text: `    ⏱️  Execution Time: ${execTimeText} ns${execTimeChange}`,
                        // });
                        // output.push({text: ''});
                    }
                });
            }

            // Summary
            output.push({text: '📋 Summary:'});
            output.push({
                text: `    Total Functions: ${data.functionCount}`,
            });

            // Performance comparison summary
            const totalComparisons = improvedFunctions + degradedFunctions + unchangedFunctions;
            if (totalComparisons > 0) {
                output.push({text: ''});
                output.push({text: '🔄 Performance Changes vs Previous Run:'});
                output.push({
                    text: `    🟢 Improved: ${improvedFunctions} functions/ASM blocks`,
                });
                output.push({
                    text: `    🔴 Degraded: ${degradedFunctions} functions/ASM blocks`,
                });
                output.push({
                    text: `    ≈ Unchanged: ${unchangedFunctions} functions/ASM blocks`,
                });
            } else {
                output.push({text: ''});
                output.push({text: '📝 First run - no previous data for comparison'});
            }
        } else if (data.result?.error) {
            output.push({
                text: `❌ Error parsing ML model response: ${data.result.error}`,
            });
        } else {
            output.push({
                text: '❌ No valid ML model results received',
            });
        }

        return output;
    }

    override async runTool(
        compilationInfo: CompilationInfo,
        inputFilepath?: string,
        args?: string[],
    ): Promise<ToolResult> {
        try {
            console.log('LOCI: runTool called');
            console.log('LOCI: compilationInfo keys:', Object.keys(compilationInfo));
            console.log('LOCI: compilationInfo.asm type:', typeof compilationInfo.asm);
            console.log('LOCI: compilationInfo.asm exists:', !!compilationInfo.asm);
            console.log('LOCI: compilationInfo.result exists:', !!compilationInfo.result);
            if (compilationInfo.result) {
                console.log('LOCI: compilationInfo.result keys:', Object.keys(compilationInfo.result));
                console.log('LOCI: compilationInfo.result.asm exists:', !!compilationInfo.result.asm);
            }

            // Debug the full assembly structure
            if (compilationInfo.asm) {
                if (Array.isArray(compilationInfo.asm)) {
                    console.log('LOCI: compilationInfo.asm is array with length:', compilationInfo.asm.length);
                    if (compilationInfo.asm.length > 0) {
                        console.log('LOCI: First asm element:', compilationInfo.asm[0]);
                    }
                } else {
                    console.log('LOCI: compilationInfo.asm is string with length:', compilationInfo.asm.length);
                }
            }

            // First get the raw assembly string
            const rawAsmString = utils.normalizeAsmToString(compilationInfo.asm);
            console.log('LOCI: Raw assembly string length:', rawAsmString.length);

            if (!rawAsmString.trim()) {
                return {
                    id: this.tool.id,
                    name: this.tool.name || 'LOCI Performance Insights',
                    code: 1,
                    languageId: compilationInfo.compiler?.lang || 'unknown',
                    stderr: [],
                    stdout: [{text: '❌ No raw assembly available'}],
                    artifact: undefined,
                };
            }

            // Parse the raw assembly using the ASM parser (same as frontend)
            const parsedAsm = compilationInfo.asmParser.process(rawAsmString, compilationInfo.filters);
            console.log('LOCI: Parsed assembly lines count:', parsedAsm.asm.length);

            // Now extract text using the same method as compiler.ts frontend
            const asmText = _.pluck(parsedAsm.asm, 'text').join('\n');
            console.log('LOCI: Final assembly text length:', asmText.length);
            if (asmText.length > 0) {
                console.log('LOCI: First 200 chars of parsed assembly:', asmText.substring(0, 200));
            }

            if (!asmText.trim()) {
                return {
                    id: this.tool.id,
                    name: this.tool.name || 'LOCI Performance Insights',
                    code: 1,
                    languageId: compilationInfo.compiler?.lang || 'unknown',
                    stderr: [],
                    stdout: [{text: '❌ Empty assembly code'}],
                    artifact: undefined,
                };
            }

            // Call ML model API
            const mlResults = await this.callMLModelAPI(asmText);

            // Format results for display
            const formattedResults = this.formatMLResults(mlResults, parsedAsm, asmText);

            return {
                id: this.tool.id,
                name: this.tool.name || 'LOCI Performance Insights',
                code: 0,
                languageId: compilationInfo.compiler?.lang || 'unknown',
                stderr: [],
                stdout: formattedResults,
                artifact: undefined,
            };
        } catch (error) {
            logger.error('LOCI tool error:', error);
            return {
                id: this.tool.id,
                name: this.tool.name || 'LOCI Performance Insights',
                code: 1,
                languageId: compilationInfo.compiler?.lang || 'unknown',
                stderr: [{text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`}],
                stdout: [{text: '❌ Failed to analyze assembly code with ML model'}],
                artifact: undefined,
            };
        }
    }
}
