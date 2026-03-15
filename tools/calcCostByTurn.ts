import * as fs from 'fs';
import * as path from 'path';

// Pricing per 1M tokens
const PRICING = {
    'MODEL_PLACEHOLDER_M26': { in: 5.00, out: 25.00, cacheWrite: 6.25, cacheRead: 0.50 }, // Opus
    'MODEL_PLACEHOLDER_M35': { in: 3.00, out: 15.00, cacheWrite: 3.75, cacheRead: 0.30 }, // Sonnet
    'MODEL_PLACEHOLDER_M37': { in: 1.25, out: 10.00, cacheWrite: 1.25, cacheRead: 0.3125 }, // Gemini Pro (assuming 25% cache read)
    'MODEL_PLACEHOLDER_M47': { in: 0.15, out: 0.60, cacheWrite: 0.15, cacheRead: 0.0375 }, // Gemini Flash
    'DEFAULT': { in: 1.25, out: 10.00, cacheWrite: 1.25, cacheRead: 0.3125 }
};

interface Message {
    type: string;
    content: string;
    model?: string;
    tokens?: { input: number; output: number; };
    toolCalls?: Array<{name: string, args: string}>;
    stepIndex: number;
}

interface ExportData {
    messages: Message[];
    model: string;
}

function estimateTokens(text: string): number {
    if (!text) return 0;
    let ascii = 0, nonAscii = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) < 128) ascii++;
        else nonAscii++;
    }
    return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

function calculateCosts(filePath: string) {
    console.log(`Analyzing: ${path.basename(filePath)}\n`);
    
    const data: ExportData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const defaultModel = data.model;
    const pricing = PRICING[defaultModel as keyof typeof PRICING] || PRICING.DEFAULT;
    
    let currentContextTokens = 0; // Accumulator for context size
    
    // Cost accumulators
    let totalUncachedCost = 0;
    let totalCachedCost = 0;
    
    let turnCount = 0;
    
    const turnDetails = [];

    // Base system prompt + tools overhead (rough estimate)
    const BASE_SYSTEM_OVERHEAD = 1500; 
    currentContextTokens += BASE_SYSTEM_OVERHEAD;

    let processingTurn = false;
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let newContextTokens = 0;

    for (const msg of data.messages) {
        if (msg.type === 'checkpoint') continue;

        let msgTokens = 0;
        
        if (msg.type === 'user') {
            msgTokens = estimateTokens(msg.content);
            
            // New turn starts! The user sent a message.
            if (processingTurn) {
                // Seal the previous turn
                turnDetails.push(finalizeTurn(turnCount, turnInputTokens, turnOutputTokens, currentContextTokens, newContextTokens, pricing));
                // Add the previous turn's output to the total persistent context
                currentContextTokens += turnOutputTokens;
            }
            
            turnCount++;
            processingTurn = true;
            turnInputTokens = currentContextTokens + msgTokens; // Send everything accumulated so far + new msg
            newContextTokens = msgTokens; // Only this message is new relative to the cache
            turnOutputTokens = 0;
            currentContextTokens += msgTokens; // User msg becomes part of persistent context for next turn
            
        } else if (msg.type === 'assistant') {
            const contentTokens = estimateTokens(msg.content || '');
            let toolTokens = 0;
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    toolTokens += estimateTokens(tc.name + JSON.stringify(tc.args));
                }
            }
            const outTokens = contentTokens + toolTokens;
            turnOutputTokens += outTokens; // AI's response adds to the output of this turn
            newContextTokens += outTokens; // Output becomes part of the new context for the *next* turn
            
        } else if (msg.type === 'tool_result') {
           const trTokens = estimateTokens(msg.content || '');
           currentContextTokens += trTokens;
           newContextTokens += trTokens;
        }
    }
    
    // Seal the last turn
    if (processingTurn) {
        turnDetails.push(finalizeTurn(turnCount, turnInputTokens, turnOutputTokens, currentContextTokens, newContextTokens, pricing));
    }
    
    // Sum it up
    for (const t of turnDetails) {
        totalUncachedCost += t.uncachedCost;
        totalCachedCost += t.cachedCost;
    }

    console.log(`=== Simulation Results for ${defaultModel} ===`);
    console.log(`Total Conversation Turns (User Messages): ${turnCount}`);
    console.log(`Final Context Size: ~${Math.round(currentContextTokens/1000)}k tokens\n`);
    
    console.log("Turn-by-turn breakdown (Sample of first 3 and last 3):");
    
    turnDetails.forEach((t, i) => {
        if (i < 3 || i >= turnDetails.length - 3) {
            console.log(`Turn ${t.id}: Context sent = ${Math.round(t.inputTokens)} tokens | Output = ${Math.round(t.outputTokens)} tokens`);
            console.log(`           Cost: Uncached $${t.uncachedCost.toFixed(4)} | Cached $${t.cachedCost.toFixed(4)}`);
        }
        if (i === 3 && turnDetails.length > 6) console.log("           ...");
    });
    
    console.log(`\n=== Final Estimated API Cost ===`);
    console.log(`💥 Uncached API Cost (e.g. basic proxies): $${totalUncachedCost.toFixed(2)}`);
    console.log(`✨ Cached API Cost (e.g. Anthropic API):   $${totalCachedCost.toFixed(2)}`);
    console.log(`📝 AGP Checkpoint Estimate (Internal):     $2.28 (from previous analysis)`);
    console.log(`\nDiff: Uncached is ${(totalUncachedCost / 2.28).toFixed(1)}x higher than AGP estimate.`);
    console.log(`Diff: Cached is ${(totalCachedCost / 2.28).toFixed(1)}x higher than AGP estimate.`);
    console.log(`Cache Savings: 节省了 $${(totalUncachedCost - totalCachedCost).toFixed(2)} (${((1 - totalCachedCost/totalUncachedCost)*100).toFixed(0)}%)`);

}

function finalizeTurn(id: number, inputToks: number, outputToks: number, cacheHistorySize: number, newToks: number, pricing: any) {
    const outCost = (outputToks / 1000000) * pricing.out;
    
    // Uncached: Charge full prepended history + new tokens at standard input rate
    const inCostUncached = (inputToks / 1000000) * pricing.in;
    const uncachedTotal = inCostUncached + outCost;
    
    let inCostCached = 0;
    if (id === 1) {
        // Turn 1: Write everything to cache
        inCostCached = (inputToks / 1000000) * pricing.cacheWrite;
    } else {
        // Subsequent turns: Read history, write new
        const historyToRead = cacheHistorySize - newToks;
        const cacheReadCost = (historyToRead / 1000000) * pricing.cacheRead;
        const cacheWriteCost = (newToks / 1000000) * pricing.cacheWrite;
        inCostCached = cacheReadCost + cacheWriteCost;
    }
    
    const cachedTotal = inCostCached + outCost;
    
    return {
        id,
        inputTokens: inputToks,
        outputTokens: outputToks,
        uncachedCost: uncachedTotal,
        cachedCost: cachedTotal
    };
}

const file = process.argv[2];
if (file) calculateCosts(file);
else console.log("Provide JSON file path");
