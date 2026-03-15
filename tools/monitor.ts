#!/usr/bin/env node
// ─── AGP Standalone Monitor ──────────────────────────────────────────────────
// Polls the Antigravity LS for quota data without requiring VS Code.
// Records remainingFraction snapshots to workspace-local .agp/ folder.
//
// Usage:
//   npx tsx tools/monitor.ts [workspace-path]       — monitor mode
//   npx tsx tools/monitor.ts --export [workspace]   — export a conversation
//
// Data is saved to <workspace>/.agp/
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { discoverLanguageServer, LSInfo } from '../src/discovery';
import {
    fetchModelConfigs,
    getAllTrajectories,
    getTrajectoryTokenUsage,
    getConversationExport,
    getModelDisplayName,
    processSteps,
    ModelConfig,
    TrajectorySummary,
    ConversationExport,
} from '../src/tracker';
import { getQuotaGroup, QuotaGroup } from '../src/modelGroups';

// ─── Configuration ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const AGP_DIR = '.agp';
const SNAPSHOTS_FILE = 'quota_snapshots.jsonl';
const OBSERVATIONS_FILE = 'observations.jsonl';
const PRECISION_FILE = 'precision_report.json';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SnapshotRecord {
    ts: number;
    model: string;
    group: QuotaGroup;
    fraction: number;
    resetTime: string;
    cascade?: string;
    dIn: number;
    dOut: number;
    dCache: number;
}

interface ObservationRecord {
    ts: number;
    model: string;
    group: QuotaGroup;
    frBefore: number;
    frAfter: number;
    dFr: number;
    dIn: number;
    dOut: number;
    dCache: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

let lsInfo: LSInfo | null = null;
let previousFractions = new Map<string, number>();
let previousTokens = new Map<string, { input: number; output: number }>();
let snapshotCount = 0;
let observationCount = 0;
let running = true;

// ─── Workspace Resolution ────────────────────────────────────────────────────

function resolveWorkspace(): string {
    // Skip flags like --export when looking for workspace path
    const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const arg = args[0];
    if (arg) {
        const resolved = path.resolve(arg);
        if (!fs.existsSync(resolved)) {
            console.error(`❌ Workspace path does not exist: ${resolved}`);
            process.exit(1);
        }
        return resolved;
    }
    return process.cwd();
}

function ensureAgpDir(workspace: string): string {
    const agpDir = path.join(workspace, AGP_DIR);
    if (!fs.existsSync(agpDir)) {
        fs.mkdirSync(agpDir, { recursive: true });
        log(`Created ${AGP_DIR}/ directory`);

        // Check if .gitignore exists and remind user
        const gitignore = path.join(workspace, '.gitignore');
        if (fs.existsSync(gitignore)) {
            const content = fs.readFileSync(gitignore, 'utf-8');
            if (!content.includes('.agp')) {
                console.log(`\n  ⚠️  Remember to add "${AGP_DIR}/" to your .gitignore\n`);
            }
        } else {
            console.log(`\n  ⚠️  No .gitignore found. Consider adding "${AGP_DIR}/" if using git.\n`);
        }
    }
    return agpDir;
}

// ─── File I/O ────────────────────────────────────────────────────────────────

function appendJsonl(filepath: string, record: object): void {
    fs.appendFileSync(filepath, JSON.stringify(record) + '\n', 'utf-8');
}

function writeJson(filepath: string, data: object): void {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`[${ts}] ${msg}`);
}

function logColor(msg: string, color: string): void {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`[${ts}] ${color}${msg}\x1b[0m`);
}

// ─── Poll Logic ──────────────────────────────────────────────────────────────

async function discoverLS(workspace: string): Promise<LSInfo | null> {
    // Convert workspace path to file:// URI for LS matching
    const workspaceUri = `file:///${workspace.replace(/\\/g, '/')}`;
    try {
        return await discoverLanguageServer(workspaceUri);
    } catch (err) {
        log(`LS discovery error: ${err}`);
        return null;
    }
}

async function pollOnce(
    ls: LSInfo,
    agpDir: string,
    workspace: string
): Promise<void> {
    // 1. Fetch model configs (contains remainingFraction)
    let configs: ModelConfig[];
    try {
        configs = await fetchModelConfigs(ls);
    } catch (err) {
        log(`fetchModelConfigs failed: ${err}`);
        return;
    }

    if (configs.length === 0) {
        log('No model configs returned');
        return;
    }

    // 2. Get active cascade for context
    let activeCascadeId: string | undefined;
    try {
        const trajectories = await getAllTrajectories(ls);
        const running = trajectories.find(t => t.status === 'CASCADE_RUN_STATUS_RUNNING');
        const recent = trajectories[0]; // Already sorted by lastModifiedTime desc
        activeCascadeId = running?.cascadeId || recent?.cascadeId;

        // If we have an active cascade, get its token usage for delta context
        if (activeCascadeId && recent) {
            try {
                const usage = await getTrajectoryTokenUsage(ls, activeCascadeId, recent.stepCount);
                if (usage.lastModelUsage) {
                    const key = activeCascadeId;
                    const prev = previousTokens.get(key);
                    const currIn = usage.lastModelUsage.inputTokens;
                    const currOut = usage.lastModelUsage.outputTokens;
                    const currCache = usage.lastModelUsage.cacheReadTokens;

                    // Store current tokens for next delta
                    previousTokens.set(key, { input: currIn, output: currOut });

                    // Compute deltas
                    if (prev) {
                        const dIn = currIn - prev.input;
                        const dOut = currOut - prev.output;
                        if (dIn > 0 || dOut > 0) {
                            log(`Token delta: in=${dIn > 0 ? '+' : ''}${dIn} out=${dOut > 0 ? '+' : ''}${dOut} cache=${currCache}`);
                        }
                    }
                }
            } catch {
                // Silent — token usage is supplementary
            }
        }
    } catch {
        // Trajectory fetch failed — continue with fraction recording
    }

    // 3. Record snapshots for each model with remainingFraction
    const snapshotsFile = path.join(agpDir, SNAPSHOTS_FILE);
    const observationsFile = path.join(agpDir, OBSERVATIONS_FILE);
    const allFractions: number[] = [];

    for (const cfg of configs) {
        if (cfg.remainingFraction === undefined || !cfg.model) continue;

        const group = getQuotaGroup(cfg.model);
        if (!group) continue;

        const fraction = cfg.remainingFraction;
        allFractions.push(fraction);

        // Compute token deltas for this snapshot
        const prevTokenData = previousTokens.get(activeCascadeId || '');
        const dIn = 0; // Will be refined with per-model tracking
        const dOut = 0;

        const snapshot: SnapshotRecord = {
            ts: Date.now(),
            model: cfg.model,
            group,
            fraction,
            resetTime: cfg.resetTime || '',
            cascade: activeCascadeId,
            dIn,
            dOut,
            dCache: 0,
        };

        appendJsonl(snapshotsFile, snapshot);
        snapshotCount++;

        // Check for observation (fraction changed)
        const prevFraction = previousFractions.get(cfg.model);
        previousFractions.set(cfg.model, fraction);

        if (prevFraction !== undefined) {
            const delta = prevFraction - fraction;

            if (Math.abs(delta) < 1e-15) {
                // No change
                log(`${group.padEnd(13)} fraction=${fraction}  (no change)`);
            } else if (delta < 0) {
                // Reset detected
                logColor(
                    `${group.padEnd(13)} fraction=${prevFraction} → ${fraction}  ⟳ RESET`,
                    '\x1b[33m' // yellow
                );
            } else {
                // Consumption!
                const obs: ObservationRecord = {
                    ts: Date.now(),
                    model: cfg.model,
                    group,
                    frBefore: prevFraction,
                    frAfter: fraction,
                    dFr: delta,
                    dIn,
                    dOut,
                    dCache: 0,
                };
                appendJsonl(observationsFile, obs);
                observationCount++;

                logColor(
                    `${group.padEnd(13)} fraction=${prevFraction.toFixed(17)} → ${fraction.toFixed(17)}  ` +
                    `Δ=${delta.toFixed(17)}`,
                    '\x1b[32m' // green
                );
            }
        } else {
            // First time seeing this model
            log(`${group.padEnd(13)} fraction=${fraction}  (initial)`);
        }
    }

    // 4. Update precision report
    if (allFractions.length > 0) {
        updatePrecisionReport(agpDir, allFractions);
    }
}

// ─── Precision Analysis ──────────────────────────────────────────────────────

function updatePrecisionReport(agpDir: string, newFractions: number[]): void {
    const reportFile = path.join(agpDir, PRECISION_FILE);

    let existing: { fractions: number[]; maxDecimals: number; minDecimals: number } = {
        fractions: [],
        maxDecimals: 0,
        minDecimals: Infinity,
    };

    try {
        if (fs.existsSync(reportFile)) {
            existing = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
        }
    } catch { /* Start fresh */ }

    // Collect unique non-trivial fractions
    const allFractions = new Set([...existing.fractions, ...newFractions]);
    const uniqueFractions = [...allFractions].filter(f => f > 0 && f < 1);

    const decimalCounts = uniqueFractions.map(f => {
        const s = f.toString();
        const dot = s.indexOf('.');
        return dot >= 0 ? s.length - dot - 1 : 0;
    });

    const maxDecimals = decimalCounts.length > 0 ? Math.max(...decimalCounts) : 0;
    const minDecimals = decimalCounts.length > 0 ? Math.min(...decimalCounts) : 0;

    writeJson(reportFile, {
        lastUpdated: new Date().toISOString(),
        sampleCount: uniqueFractions.length,
        maxDecimals,
        minDecimals,
        sternBrocotViable: maxDecimals >= 10,
        examples: uniqueFractions.slice(0, 20),
        fractions: uniqueFractions.slice(0, 100), // Keep up to 100 unique values
    });
}

// ─── Interactive Prompt ──────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// ─── Export Mode ─────────────────────────────────────────────────────────────

async function exportConversation(workspace: string): Promise<void> {
    console.log('');
    console.log('  ┌──────────────────────────────────────────┐');
    console.log('  │  AGP Export — Conversation Exporter       │');
    console.log('  └──────────────────────────────────────────┘');
    console.log('');
    console.log(`  Workspace: ${workspace}`);
    console.log('');

    // 1. Discover LS
    log('Discovering Antigravity LS...');
    const workspaceUri = `file:///${workspace.replace(/\\/g, '/')}`;
    let ls: LSInfo | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            ls = await discoverLanguageServer(workspaceUri);
            if (ls) break;
        } catch { /* retry */ }
        log('LS not found, retrying...');
        await sleep(2000);
    }
    if (!ls) {
        console.error('❌ Could not discover Antigravity LS. Is Antigravity running?');
        process.exit(1);
    }
    log(`LS found: port=${ls.port}, tls=${ls.useTls}, pid=${ls.pid}`);

    // 2. Fetch all conversations
    log('Fetching conversation list...');
    const trajectories = await getAllTrajectories(ls);
    if (trajectories.length === 0) {
        console.log('  No conversations found.');
        process.exit(0);
    }

    // 3. Fetch quota info for context
    let quotaInfo: { remainingFraction: number; resetTime: string } | undefined;
    try {
        const configs = await fetchModelConfigs(ls);
        const withQuota = configs.find(c => c.remainingFraction !== undefined);
        if (withQuota && withQuota.remainingFraction !== undefined) {
            quotaInfo = {
                remainingFraction: withQuota.remainingFraction,
                resetTime: withQuota.resetTime || '',
            };
        }
    } catch { /* ok */ }

    // 4. Display conversation list
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────────────┐');
    console.log('  │  Available Conversations                                     │');
    console.log('  └──────────────────────────────────────────────────────────────┘');
    console.log('');

    for (let i = 0; i < trajectories.length; i++) {
        const t = trajectories[i];
        const model = getModelDisplayName(t.requestedModel || t.generatorModel).split(' / ')[0];
        const statusIcon = t.status === 'CASCADE_RUN_STATUS_RUNNING' ? '🟢' :
                          t.status === 'CASCADE_RUN_STATUS_FINISHED' ? '⚪' : '🔴';
        const time = t.lastModifiedTime
            ? new Date(t.lastModifiedTime).toLocaleString()
            : 'unknown';
        const title = (t.summary || t.cascadeId).substring(0, 50);
        console.log(
            `  ${String(i + 1).padStart(3)}. ${statusIcon} [${model.padEnd(20)}] ` +
            `${t.stepCount.toString().padStart(4)} steps | ${time}`
        );
        console.log(`       ${title}`);
    }

    console.log('');

    // 5. User picks a conversation
    const input = await prompt('  Select conversation number (or q to quit): ');
    if (input.toLowerCase() === 'q' || !input) {
        console.log('  Cancelled.');
        process.exit(0);
    }

    const idx = parseInt(input, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= trajectories.length) {
        console.error(`  ❌ Invalid selection: ${input}`);
        process.exit(1);
    }

    const selected = trajectories[idx];
    const selectedTitle = (selected.summary || selected.cascadeId).substring(0, 40);
    log(`Exporting: "${selectedTitle}" (${selected.stepCount} steps)...`);

    // 6. Export
    const exported = await getConversationExport(ls, selected, quotaInfo);

    // 7. Save to file
    const agpDir = ensureAgpDir(workspace);
    const exportsDir = path.join(agpDir, 'exports');
    if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
    }

    const safeTitle = (selected.summary || 'conversation')
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_]/g, '_')
        .substring(0, 50);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `${safeTitle}_${timestamp}.json`;
    const filepath = path.join(exportsDir, filename);

    writeJson(filepath, exported);

    // 8. Summary
    console.log('');
    console.log('  ┌──────────────────────────────────────────┐');
    console.log('  │  Export Complete ✅                        │');
    console.log('  └──────────────────────────────────────────┘');
    console.log('');
    console.log(`  📄 File: ${filepath}`);
    console.log(`  💬 Messages: ${exported.messages.length}`);
    console.log(`  📊 Steps: ${exported.stepCount}`);
    console.log(`  🤖 Model: ${exported.modelDisplayName}`);
    console.log(`  📤 Sends: ${exported.usage.sendCount}  📥 Responses: ${exported.usage.responseCount}  🔄 Retries: ${exported.usage.retryCount}`);
    console.log(`  🔢 Input: ${(exported.usage.totalInputTokens / 1000).toFixed(1)}k  Output: ${(exported.usage.totalOutputTokens / 1000).toFixed(1)}k`);
    console.log(`  💰 Est. Cost: $${exported.usage.estimatedCost.toFixed(4)}`);
    if (exported.quota) {
        console.log(`  📉 Quota Remaining: ${(exported.quota.remainingFraction * 100).toFixed(2)}%`);
    }
    const sizeKB = (Buffer.byteLength(JSON.stringify(exported, null, 2)) / 1024).toFixed(1);
    console.log(`  📦 File size: ${sizeKB} KB`);
    console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const isExportMode = process.argv.includes('--export');
    const workspace = resolveWorkspace();

    if (isExportMode) {
        return exportConversation(workspace);
    }

    console.log('');
    console.log('  ┌─────────────────────────────────────────┐');
    console.log('  │  AGP Monitor — Quota Snapshot Collector  │');
    console.log('  └─────────────────────────────────────────┘');
    console.log('');
    console.log(`  Workspace: ${workspace}`);
    console.log(`  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
    console.log(`  Data dir: ${path.join(workspace, AGP_DIR)}/`);
    console.log('');

    const agpDir = ensureAgpDir(workspace);

    // Graceful shutdown
    process.on('SIGINT', () => {
        running = false;
        console.log('');
        log('Shutting down...');
        log(`Session summary: ${snapshotCount} snapshots, ${observationCount} observations`);
        log(`Data saved to: ${agpDir}/`);
        process.exit(0);
    });

    // Discovery loop
    log('Discovering Antigravity LS...');

    while (running) {
        // Discover / rediscover LS
        if (!lsInfo) {
            lsInfo = await discoverLS(workspace);
            if (lsInfo) {
                log(`LS found: port=${lsInfo.port}, tls=${lsInfo.useTls}, pid=${lsInfo.pid}`);

                // Fetch initial model list
                try {
                    const configs = await fetchModelConfigs(lsInfo);
                    const labels = configs.map(c => c.label).filter(Boolean);
                    if (labels.length > 0) {
                        log(`Models: ${labels.join(', ')}`);
                    }
                } catch { /* ok */ }
            } else {
                log('LS not found, retrying...');
                await sleep(POLL_INTERVAL_MS * 2);
                continue;
            }
        }

        // Poll
        try {
            await pollOnce(lsInfo, agpDir, workspace);
        } catch (err) {
            log(`Poll error: ${err}`);
            lsInfo = null; // Force rediscovery
        }

        await sleep(POLL_INTERVAL_MS);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Run ─────────────────────────────────────────────────────────────────────
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
