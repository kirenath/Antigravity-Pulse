#!/usr/bin/env npx tsx
/**
 * AGP Cost Calculator CLI
 * 
 * Calculates equivalent API costs from AGP conversation export JSONs.
 * Splits by user messages (turns), supports compression detection,
 * checkpoint calibration, and cached vs uncached comparison.
 * 
 * Usage:
 *   npx tsx tools/calcCostByTurn.ts <file.json> [file2.json ...]
 *   npx tsx tools/calcCostByTurn.ts .agp/exports/*.json
 */
import * as fs from 'fs';
import * as path from 'path';

// ── Pricing per 1M tokens ────────────────────────────────────────────────────
const PRICING: Record<string, { name: string; in: number; out: number; cacheWrite: number; cacheRead: number }> = {
    'MODEL_PLACEHOLDER_M26': { name: 'Claude Opus 4.6',    in: 5.00,  out: 25.00, cacheWrite: 6.25,   cacheRead: 0.50   },
    'MODEL_PLACEHOLDER_M35': { name: 'Claude Sonnet 4.6',  in: 3.00,  out: 15.00, cacheWrite: 3.75,   cacheRead: 0.30   },
    'MODEL_PLACEHOLDER_M37': { name: 'Gemini 3.1 Pro (H)', in: 1.25,  out: 10.00, cacheWrite: 1.5625, cacheRead: 0.3125 },
    'MODEL_PLACEHOLDER_M36': { name: 'Gemini 3.1 Pro (L)', in: 1.25,  out: 10.00, cacheWrite: 1.5625, cacheRead: 0.3125 },
    'MODEL_PLACEHOLDER_M18': { name: 'Gemini 3 Flash',     in: 0.15,  out: 0.60,  cacheWrite: 0.1875, cacheRead: 0.0375 },
    'MODEL_PLACEHOLDER_M47': { name: 'Gemini 3 Flash',     in: 0.15,  out: 0.60,  cacheWrite: 0.1875, cacheRead: 0.0375 },
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': { name: 'GPT-OSS 120B', in: 1.25, out: 10.00, cacheWrite: 1.25, cacheRead: 0.625 },
    'DEFAULT':              { name: 'Unknown',             in: 1.25,  out: 10.00, cacheWrite: 1.5625, cacheRead: 0.3125 },
};

const COMPRESSION_MIN_DROP = 5000;

// ── Types ────────────────────────────────────────────────────────────────────
interface Message {
    type: string;
    content: string;
    thinking?: string;
    tokens?: { input: number; output: number; cacheRead: number; responseOutput: number };
    toolCalls?: Array<{ name: string; args: string }>;
    stepIndex: number;
    model?: string;
}

interface ExportData {
    title: string;
    cascadeId: string;
    model: string;
    messages: Message[];
    usage?: {
        estimatedCost?: number;
        sendCount?: number;
        responseCount?: number;
        retryCount?: number;
        compressionDetected?: boolean;
    };
}

interface TurnResult {
    id: number;
    inputTokens: number;   // first sub-call's input (context at turn start, for display)
    outputTokens: number;  // total output across all sub-calls
    uncached: number;       // sum of all sub-calls
    cached: number;         // sum of all sub-calls
    compressed: boolean;
    subCallCount: number;   // how many API calls this turn made
}

// ── Token estimation ─────────────────────────────────────────────────────────
function estimateTokens(text: string): number {
    if (!text) return 0;
    let ascii = 0, nonAscii = 0;
    for (let i = 0; i < text.length; i++) {
        text.charCodeAt(i) < 128 ? ascii++ : nonAscii++;
    }
    return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

function fmtK(n: number): string {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
}

function fmt$(n: number): string {
    if (n < 0.01 && n > 0) return '<$0.01';
    return '$' + n.toFixed(2);
}

// ── Core calculation ─────────────────────────────────────────────────────────

/**
 * Calculate cost for a single API sub-call.
 * Each assistant response within a turn is one sub-call.
 */
function calcSubCallCost(
    inputTokens: number,
    outputTokens: number,
    prevInputTokens: number,
    pricing: typeof PRICING['DEFAULT'],
    isFirstInConversation: boolean,
    isPostCompression: boolean,
): { uncached: number; cached: number } {
    const outCost = (outputTokens / 1e6) * pricing.out;
    const uncachedIn = (inputTokens / 1e6) * pricing.in;
    let cachedIn: number;
    if (isFirstInConversation || isPostCompression) {
        // Cold cache: everything is a cache write
        cachedIn = (inputTokens / 1e6) * pricing.cacheWrite;
    } else {
        // Split: previous sub-call's input is cached, delta is new
        const cacheRead = Math.max(0, prevInputTokens);
        const cacheWrite = Math.max(0, inputTokens - prevInputTokens);
        cachedIn = (cacheRead / 1e6) * pricing.cacheRead + (cacheWrite / 1e6) * pricing.cacheWrite;
    }
    return {
        uncached: uncachedIn + outCost,
        cached: cachedIn + outCost,
    };
}

function analyzeFile(filePath: string) {
    const data: ExportData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const pricing = PRICING[data.model] || PRICING.DEFAULT;
    const BASE_OVERHEAD = 1500;

    const messages = data.messages || [];

    // ── Sub-call tracking state ─────────────────────────────────────────
    let contextTokens = BASE_OVERHEAD;
    /** The input size of the most recently completed sub-call (for cache split). */
    let prevSubCallInput = 0;
    let isFirstSubCall = true;
    let isPostCompression = false;

    // Per-turn accumulation
    let turnId = 0;
    let inTurn = false;
    let turnStartInput = 0;       // first sub-call's input (for display)
    let turnCompressed = false;
    interface SubCallResult { inputTokens: number; outputTokens: number; uncached: number; cached: number; compressed: boolean }
    let turnSubCalls: SubCallResult[] = [];

    const turns: TurnResult[] = [];

    // Compression tracking
    let prevCpInput = -1;
    const compressionEvents: Array<{ from: number; to: number; drop: number }> = [];

    // ── Helper: finalize a turn from accumulated sub-calls ──────────────
    function finalizeTurn(): void {
        if (!inTurn || turnSubCalls.length === 0) return;
        let totalOutput = 0, uncached = 0, cached = 0;
        for (const sc of turnSubCalls) {
            totalOutput += sc.outputTokens;
            uncached += sc.uncached;
            cached += sc.cached;
        }
        turns.push({
            id: turnId,
            inputTokens: turnStartInput,
            outputTokens: totalOutput,
            uncached,
            cached,
            compressed: turnCompressed,
            subCallCount: turnSubCalls.length,
        });
    }

    // ── Main message loop ───────────────────────────────────────────────
    for (const msg of messages) {
        // Checkpoint — compression detection & context calibration
        if (msg.type === 'checkpoint') {
            const cpInput = msg.tokens?.input || 0;
            if (cpInput > 0) {
                if (prevCpInput > 0 && cpInput < prevCpInput) {
                    const drop = prevCpInput - cpInput;
                    if (drop > COMPRESSION_MIN_DROP) {
                        compressionEvents.push({ from: prevCpInput, to: cpInput, drop });
                        contextTokens = cpInput;
                        isPostCompression = true;
                    }
                } else {
                    contextTokens = Math.max(contextTokens, cpInput);
                }
                prevCpInput = cpInput;
            }
            continue;
        }

        if (msg.type === 'user') {
            // Finalize previous turn
            finalizeTurn();

            // Start new turn
            const tokens = estimateTokens(msg.content);
            contextTokens += tokens;
            turnId++;
            inTurn = true;
            turnStartInput = contextTokens;
            turnCompressed = isPostCompression;
            turnSubCalls = [];
            continue;
        }

        if (msg.type === 'assistant') {
            // Each assistant message = one API sub-call
            let out = estimateTokens(msg.content || '');
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    out += estimateTokens((tc.name || '') + (tc.args || ''));
                }
            }
            if (msg.thinking) out += estimateTokens(msg.thinking);

            // Calculate cost for this sub-call
            const costs = calcSubCallCost(
                contextTokens, out, prevSubCallInput,
                pricing, isFirstSubCall, isPostCompression,
            );
            turnSubCalls.push({
                inputTokens: contextTokens,
                outputTokens: out,
                uncached: costs.uncached,
                cached: costs.cached,
                compressed: isPostCompression,
            });

            // Update state: this sub-call's input becomes the cache baseline
            prevSubCallInput = contextTokens;
            isFirstSubCall = false;
            if (isPostCompression) isPostCompression = false;

            // Assistant output becomes part of context for the next sub-call
            contextTokens += out;
            continue;
        }

        // tool_result / tool_call — kept for robustness (not in current exports)
        if (msg.type === 'tool_result' || msg.type === 'tool_call') {
            const t = estimateTokens(msg.content || '');
            contextTokens += t;
            continue;
        }
    }
    // Finalize last turn
    finalizeTurn();

    let totalUncached = 0, totalCached = 0;
    for (const t of turns) { totalUncached += t.uncached; totalCached += t.cached; }

    const agpEstimate = data.usage?.estimatedCost || 0;

    return {
        file: path.basename(filePath),
        title: data.title || data.cascadeId || 'Untitled',
        model: data.model,
        modelName: pricing.name,
        turnCount: turnId,
        sendCount: data.usage?.sendCount || turnId,
        finalContext: contextTokens,
        totalUncached, totalCached, agpEstimate,
        turns, compressionEvents,
    };
}

// ── Pretty output ────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
    gray: '\x1b[90m',
};

function printSeparator(char = '─', width = 70) {
    console.log(C.dim + char.repeat(width) + C.reset);
}

function printResult(r: ReturnType<typeof analyzeFile>) {
    console.log();
    printSeparator('═');
    console.log(`${C.bold}💬 ${r.title}${C.reset}`);
    console.log(`${C.gray}   ${r.file}${C.reset}`);
    printSeparator();

    // Meta info
    console.log(`  模型 Model     ${C.cyan}${r.modelName}${C.reset} ${C.dim}(${r.model})${C.reset}`);
    console.log(`  对话轮次 Turns  ${C.bold}${r.turnCount}${C.reset}${r.sendCount !== r.turnCount ? ` ${C.dim}/ 原始 ${r.sendCount} sends${C.reset}` : ''}`);
    console.log(`  最终上下文      ${C.bold}${fmtK(r.finalContext)}${C.reset} tokens`);
    if (r.compressionEvents.length > 0) {
        console.log(`  上下文压缩 🗜️   ${C.yellow}${r.compressionEvents.length} 次${C.reset}`);
        for (const e of r.compressionEvents) {
            console.log(`    ${C.dim}${fmtK(e.from)} → ${fmtK(e.to)} (↓${fmtK(e.drop)})${C.reset}`);
        }
    }
    printSeparator();

    // Turn-by-turn sample
    console.log(`  ${C.dim}轮次  上下文 Input      Output      无缓存💥       有缓存✨${C.reset}`);

    const showIndices = new Set<number>();
    for (let i = 0; i < Math.min(5, r.turns.length); i++) showIndices.add(i);
    for (let i = Math.max(0, r.turns.length - 3); i < r.turns.length; i++) showIndices.add(i);
    r.turns.forEach((t, i) => { if (t.compressed || t.subCallCount > 1) showIndices.add(i); });
    const sorted = [...showIndices].sort((a, b) => a - b);
    let lastShown = -1;

    for (const i of sorted) {
        if (lastShown >= 0 && i > lastShown + 1) {
            console.log(`  ${C.dim}  ⋮  跳过 ${i - lastShown - 1} 轮${C.reset}`);
        }
        const t = r.turns[i];
        const comp = t.compressed ? ` ${C.yellow}🗜️${C.reset}` : '';
        const coldTag = t.compressed ? ` ${C.yellow}(冷缓存)${C.reset}` : '';
        const subTag = t.subCallCount > 1 ? ` ${C.cyan}×${t.subCallCount}${C.reset}` : '';
        console.log(
            `  ${C.bold}#${String(t.id).padStart(3)}${C.reset}${comp}${subTag}` +
            `  ${fmtK(t.inputTokens).padStart(10)}` +
            `  ${fmtK(t.outputTokens).padStart(10)}` +
            `  ${C.red}${fmt$(t.uncached).padStart(12)}${C.reset}` +
            `  ${C.blue}${fmt$(t.cached).padStart(12)}${C.reset}${coldTag}`
        );
        lastShown = i;
    }

    printSeparator();

    // Summary
    const savings = r.totalUncached - r.totalCached;
    const savingsPct = r.totalUncached > 0 ? ((1 - r.totalCached / r.totalUncached) * 100).toFixed(0) : '0';

    console.log(`  ${C.red}${C.bold}💥 无缓存 API${C.reset}   ${C.red}${C.bold}${fmt$(r.totalUncached).padStart(10)}${C.reset}  ${C.dim}(中转站 / 随机轮询 Key)${C.reset}`);
    console.log(`  ${C.blue}${C.bold}✨ 有缓存 API${C.reset}   ${C.blue}${C.bold}${fmt$(r.totalCached).padStart(10)}${C.reset}  ${C.dim}(官方 API + Prompt Cache)${C.reset}`);
    console.log(`  ${C.green}${C.bold}📝 AGP 估算${C.reset}     ${C.green}${C.bold}${fmt$(r.agpEstimate).padStart(10)}${C.reset}  ${C.dim}(Checkpoint 快照)${C.reset}`);
    console.log();
    console.log(`  ${C.green}缓存节省: ${fmt$(savings)} (${savingsPct}%)${C.reset}`);
    if (r.agpEstimate > 0) {
        console.log(`  ${C.dim}无缓存 vs AGP: ${(r.totalUncached / r.agpEstimate).toFixed(1)}x | 有缓存 vs AGP: ${(r.totalCached / r.agpEstimate).toFixed(1)}x${C.reset}`);
    }
    printSeparator('═');
}

// ── Aggregate summary for multiple files ─────────────────────────────────────
function printAggregate(results: ReturnType<typeof analyzeFile>[]) {
    if (results.length <= 1) return;

    let sumUncached = 0, sumCached = 0, sumAgp = 0, sumTurns = 0, sumCompressions = 0;
    for (const r of results) {
        sumUncached += r.totalUncached;
        sumCached += r.totalCached;
        sumAgp += r.agpEstimate;
        sumTurns += r.turnCount;
        sumCompressions += r.compressionEvents.length;
    }

    console.log();
    printSeparator('━', 70);
    console.log(`${C.bold}${C.magenta}📊 汇总 (${results.length} 段对话 · ${sumTurns} 轮)${C.reset}`);
    printSeparator('━', 70);
    console.log(`  ${C.red}${C.bold}💥 无缓存 API  ${fmt$(sumUncached)}${C.reset}`);
    console.log(`  ${C.blue}${C.bold}✨ 有缓存 API  ${fmt$(sumCached)}${C.reset}`);
    console.log(`  ${C.green}${C.bold}📝 AGP 估算    ${fmt$(sumAgp)}${C.reset}`);
    if (sumCompressions > 0) {
        console.log(`  ${C.yellow}🗜️ 压缩事件     ${sumCompressions} 次${C.reset}`);
    }
    console.log(`  ${C.green}缓存总节省: ${fmt$(sumUncached - sumCached)} (${((1 - sumCached / sumUncached) * 100).toFixed(0)}%)${C.reset}`);
    printSeparator('━', 70);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const files = process.argv.slice(2);
if (files.length === 0) {
    console.log(`${C.bold}AGP Cost Calculator CLI${C.reset}`);
    console.log(`Usage: npx tsx ${path.basename(__filename)} <file.json> [file2.json ...]`);
    console.log(`       npx tsx ${path.basename(__filename)} .agp/exports/*.json`);
    process.exit(1);
}

const results = [];
for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`${C.red}File not found: ${f}${C.reset}`); continue; }
    try {
        results.push(analyzeFile(f));
    } catch (e) {
        console.error(`${C.red}Failed to parse ${f}: ${(e as Error).message}${C.reset}`);
    }
}

for (const r of results) printResult(r);
printAggregate(results);
