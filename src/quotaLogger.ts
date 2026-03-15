// ─── Quota Snapshot Logger ────────────────────────────────────────────────────
// Records remainingFraction from GetUserStatus on each poll cycle, paired
// with token deltas, to enable reverse-engineering of Antigravity's credits
// formula — analogous to she-llac's approach for Claude.
//
// Phase 1: Snapshot collection + log output.
// Phase 2 (future): Stern-Brocot fraction recovery + linear regression.

import * as vscode from 'vscode';
import { QuotaGroup } from './modelGroups';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single point-in-time quota reading from GetUserStatus. */
export interface QuotaSnapshot {
    /** ms since epoch */
    timestamp: number;
    /** Model ID, e.g. MODEL_PLACEHOLDER_M37 */
    model: string;
    /** Quota group */
    quotaGroup: QuotaGroup;
    /** 0.0 ~ 1.0 from API — THE KEY DATA POINT */
    remainingFraction: number;
    /** ISO timestamp — when this model's quota resets */
    resetTime: string;
    /** Active cascade at time of snapshot (if any) */
    cascadeId?: string;
    /** Token deltas since last snapshot for this model */
    deltaInputTokens?: number;
    deltaOutputTokens?: number;
    deltaCacheReadTokens?: number;
}

/** A paired observation: two consecutive snapshots showing quota consumption. */
export interface QuotaObservation {
    timestamp: number;
    model: string;
    quotaGroup: QuotaGroup;
    /** remainingFraction BEFORE consumption */
    fractionBefore: number;
    /** remainingFraction AFTER consumption */
    fractionAfter: number;
    /** How much fraction was consumed (positive = usage) */
    deltaFraction: number;
    deltaInputTokens: number;
    deltaOutputTokens: number;
    deltaCacheReadTokens: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum snapshots to retain per quota group (ringbuffer). */
const MAX_SNAPSHOTS_PER_GROUP = 200;

/** Maximum total snapshots across all groups. */
const MAX_TOTAL_SNAPSHOTS = 500;

/** Persistence key in globalState. */
const PERSIST_KEY = 'agp.quotaSnapshots';

/** Minimum delta fraction to consider an observation meaningful.
 *  Filters out noise where remainingFraction didn't actually change. */
const MIN_DELTA_FRACTION = 1e-15;

/** Throttle persistence writes (ms). */
const PERSIST_THROTTLE_MS = 30_000;

// ─── QuotaLogger ──────────────────────────────────────────────────────────────

export class QuotaLogger {
    private snapshots: QuotaSnapshot[] = [];
    private globalState: vscode.Memento;
    private dirty = false;
    private lastPersistTime = 0;

    /** Previous snapshot per model — used to compute deltas. */
    private previousByModel = new Map<string, QuotaSnapshot>();

    constructor(globalState: vscode.Memento) {
        this.globalState = globalState;
        this.load();
    }

    // ─── Recording ────────────────────────────────────────────────────────

    /**
     * Record a quota snapshot. Called from extension.ts on each poll cycle
     * when fetchModelConfigs returns remainingFraction.
     *
     * Returns the observation (paired delta) if one was computed, or null
     * if this is the first snapshot for this model in this window.
     */
    recordSnapshot(snapshot: QuotaSnapshot): QuotaObservation | null {
        this.snapshots.push(snapshot);
        this.dirty = true;

        // Trim if over capacity
        if (this.snapshots.length > MAX_TOTAL_SNAPSHOTS) {
            // Remove oldest snapshots, keeping most recent
            this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS_PER_GROUP);
        }

        // Compute observation from previous snapshot for this model
        const prev = this.previousByModel.get(snapshot.model);
        this.previousByModel.set(snapshot.model, snapshot);

        if (!prev) {
            return null; // First snapshot for this model — no delta yet
        }

        // Only create observation if fraction actually changed
        const deltaFraction = prev.remainingFraction - snapshot.remainingFraction;
        if (Math.abs(deltaFraction) < MIN_DELTA_FRACTION) {
            return null; // No change — not useful
        }

        // Skip if reset happened between snapshots (fraction went UP)
        // or resetTime changed (new 5h window started)
        if (deltaFraction < 0) {
            // Fraction increased — quota was reset
            console.log(
                `[QuotaLogger] Reset detected for ${snapshot.model}: ` +
                `${prev.remainingFraction} → ${snapshot.remainingFraction}`
            );
            return null;
        }

        const obs: QuotaObservation = {
            timestamp: snapshot.timestamp,
            model: snapshot.model,
            quotaGroup: snapshot.quotaGroup,
            fractionBefore: prev.remainingFraction,
            fractionAfter: snapshot.remainingFraction,
            deltaFraction,
            deltaInputTokens: snapshot.deltaInputTokens || 0,
            deltaOutputTokens: snapshot.deltaOutputTokens || 0,
            deltaCacheReadTokens: snapshot.deltaCacheReadTokens || 0,
        };

        return obs;
    }

    // ─── Query ────────────────────────────────────────────────────────────

    /** Get all recorded snapshots (read-only). */
    getSnapshots(): readonly QuotaSnapshot[] {
        return this.snapshots;
    }

    /** Get snapshots for a specific model. */
    getSnapshotsForModel(model: string): QuotaSnapshot[] {
        return this.snapshots.filter(s => s.model === model);
    }

    /** Get the latest snapshot for each model. */
    getLatestByModel(): Map<string, QuotaSnapshot> {
        const latest = new Map<string, QuotaSnapshot>();
        for (const s of this.snapshots) {
            const existing = latest.get(s.model);
            if (!existing || s.timestamp > existing.timestamp) {
                latest.set(s.model, s);
            }
        }
        return latest;
    }

    /**
     * Compute all meaningful observations (paired consecutive snapshots
     * where fraction decreased) for a specific model or all models.
     */
    getObservations(model?: string): QuotaObservation[] {
        const filtered = model
            ? this.snapshots.filter(s => s.model === model)
            : this.snapshots;

        // Group by model, then pair consecutive
        const byModel = new Map<string, QuotaSnapshot[]>();
        for (const s of filtered) {
            const arr = byModel.get(s.model) || [];
            arr.push(s);
            byModel.set(s.model, arr);
        }

        const observations: QuotaObservation[] = [];
        for (const [, snaps] of byModel) {
            // Sort by timestamp
            snaps.sort((a, b) => a.timestamp - b.timestamp);
            for (let i = 1; i < snaps.length; i++) {
                const prev = snaps[i - 1];
                const curr = snaps[i];
                const delta = prev.remainingFraction - curr.remainingFraction;
                // Only include consumption observations (fraction decreased)
                if (delta > MIN_DELTA_FRACTION) {
                    observations.push({
                        timestamp: curr.timestamp,
                        model: curr.model,
                        quotaGroup: curr.quotaGroup,
                        fractionBefore: prev.remainingFraction,
                        fractionAfter: curr.remainingFraction,
                        deltaFraction: delta,
                        deltaInputTokens: curr.deltaInputTokens || 0,
                        deltaOutputTokens: curr.deltaOutputTokens || 0,
                        deltaCacheReadTokens: curr.deltaCacheReadTokens || 0,
                    });
                }
            }
        }
        return observations;
    }

    /** Get precision analysis of remainingFraction values.
     *  This is critical — determines whether Stern-Brocot is viable. */
    getPrecisionInfo(): {
        sampleCount: number;
        maxDecimalPlaces: number;
        minDecimalPlaces: number;
        exampleValues: number[];
        isSufficientForSternBrocot: boolean;
    } {
        const fractions = this.snapshots
            .map(s => s.remainingFraction)
            .filter(f => f > 0 && f < 1);

        if (fractions.length === 0) {
            return {
                sampleCount: 0,
                maxDecimalPlaces: 0,
                minDecimalPlaces: 0,
                exampleValues: [],
                isSufficientForSternBrocot: false,
            };
        }

        const decimalPlaces = fractions.map(f => {
            const str = f.toString();
            const dotIdx = str.indexOf('.');
            return dotIdx >= 0 ? str.length - dotIdx - 1 : 0;
        });

        const uniqueFractions = [...new Set(fractions)].slice(0, 10);

        return {
            sampleCount: fractions.length,
            maxDecimalPlaces: Math.max(...decimalPlaces),
            minDecimalPlaces: Math.min(...decimalPlaces),
            exampleValues: uniqueFractions,
            // IEEE-754 doubles have ~17 significant digits.
            // If we see >10 decimal places, it's likely unrounded.
            isSufficientForSternBrocot: Math.max(...decimalPlaces) >= 10,
        };
    }

    // ─── Summary ──────────────────────────────────────────────────────────

    /** Get a human-readable summary for logging. */
    getSummary(): string {
        const total = this.snapshots.length;
        const byGroup = new Map<string, number>();
        for (const s of this.snapshots) {
            byGroup.set(s.quotaGroup, (byGroup.get(s.quotaGroup) || 0) + 1);
        }
        const groupStr = Array.from(byGroup.entries())
            .map(([g, n]) => `${g}=${n}`)
            .join(', ');

        const precision = this.getPrecisionInfo();
        return `QuotaLogger: ${total} snapshots [${groupStr}], ` +
            `precision=${precision.maxDecimalPlaces} decimal places, ` +
            `sternBrocotViable=${precision.isSufficientForSternBrocot}`;
    }

    // ─── Persistence ──────────────────────────────────────────────────────

    /** Persist to globalState if dirty. Throttled unless force=true. */
    persist(force = false): void {
        if (!this.dirty) { return; }
        const now = Date.now();
        if (!force && (now - this.lastPersistTime) < PERSIST_THROTTLE_MS) {
            return;
        }
        this.globalState.update(PERSIST_KEY, this.snapshots);
        this.dirty = false;
        this.lastPersistTime = now;
    }

    /** Load from globalState. */
    private load(): void {
        const persisted = this.globalState.get<QuotaSnapshot[]>(PERSIST_KEY);
        if (persisted && Array.isArray(persisted)) {
            this.snapshots = persisted;
            // Rebuild previousByModel from loaded data
            for (const s of this.snapshots) {
                const existing = this.previousByModel.get(s.model);
                if (!existing || s.timestamp > existing.timestamp) {
                    this.previousByModel.set(s.model, s);
                }
            }
        }
    }

    /** Clear all data (for testing/reset). */
    clear(): void {
        this.snapshots = [];
        this.previousByModel.clear();
        this.globalState.update(PERSIST_KEY, undefined);
        this.dirty = false;
    }
}
