// ─── 5h Window Tracker ───────────────────────────────────────────────────────
// Tracks usage within rolling 5-hour quota windows, per quota group.
// Persisted to VS Code globalState for cross-session survival.
//
// Key concepts:
// - Chain windows: first usage triggers 5h countdown; on expiry, archive + wait
//   for next usage to start a new window (no auto-create).
// - 3 independent quota groups: each has its own window lifecycle.
// - syncWithQuotaAPI: calibrate window endTime from GetUserStatus resetTime.
//
// Copyright (c) 2024 lalalavir. MIT License.

import * as vscode from 'vscode';
import { QuotaGroup, ALL_QUOTA_GROUPS, QUOTA_GROUP_LABELS } from './modelGroups';
import { calculateCost } from './cost';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WindowEvent {
    timestamp: number;         // Date.now()
    cascadeId: string;
    model: string;
    quotaGroup: QuotaGroup;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    type: 'send' | 'retry';
}

export interface WindowState {
    quotaGroup: QuotaGroup;
    startTime: number;         // Window open time
    endTime: number;           // startTime + windowDurationMs
    events: WindowEvent[];
    // Aggregates — computed from events
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    sendCount: number;
    retryCount: number;
    responseCount: number;
}

/** Serialized form for globalState persistence. */
interface PersistedState {
    windows: Array<WindowState & { quotaGroup: string }>;
    archivedWindows: Array<WindowState & { quotaGroup: string }>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'agp.windowTracker';
/** Minimum interval between globalState writes (ms). */
const PERSIST_THROTTLE_MS = 30_000;
/** Maximum archived windows to keep per group. */
const MAX_ARCHIVED_WINDOWS = 50;

// ─── WindowTracker ────────────────────────────────────────────────────────────

export class WindowTracker {
    private windows: Map<QuotaGroup, WindowState>;
    private archivedWindows: WindowState[];
    private globalState: vscode.Memento;
    private windowDurationMs: number;
    private dirty = false;
    private lastPersistTime = 0;

    constructor(globalState: vscode.Memento, windowDurationHours: number = 5) {
        this.globalState = globalState;
        this.windowDurationMs = windowDurationHours * 60 * 60 * 1000;
        this.windows = new Map();
        this.archivedWindows = [];
        this.load();
    }

    // ── Record Event ──────────────────────────────────────────────────────

    /**
     * Record a usage event into the appropriate quota group window.
     * If no active window exists for the group, a new one is created (chain window).
     */
    recordEvent(event: Omit<WindowEvent, 'timestamp'>): void {
        const now = Date.now();
        const fullEvent: WindowEvent = { ...event, timestamp: now };

        // Ensure we have an active window for this group
        let window = this.windows.get(event.quotaGroup);

        // Check if current window has expired
        if (window && now >= window.endTime) {
            this.archiveWindow(window);
            window = undefined;
        }

        // Create new window if needed (chain window behavior)
        if (!window) {
            window = this.createWindow(event.quotaGroup, now);
            this.windows.set(event.quotaGroup, window);
        }

        // Add event
        window.events.push(fullEvent);

        // Update aggregates
        window.totalInputTokens += fullEvent.inputTokens;
        window.totalOutputTokens += fullEvent.outputTokens;
        window.totalCost += fullEvent.cost;
        if (fullEvent.type === 'send') {
            window.sendCount++;
            window.responseCount++;
        } else if (fullEvent.type === 'retry') {
            window.retryCount++;
        }

        this.dirty = true;
    }

    // ── Window Lifecycle ──────────────────────────────────────────────────

    /**
     * Check all active windows for expiry and archive expired ones.
     * Called on each poll cycle.
     */
    checkWindowReset(): void {
        const now = Date.now();
        for (const [group, window] of this.windows.entries()) {
            if (now >= window.endTime) {
                this.archiveWindow(window);
                this.windows.delete(group);
                this.dirty = true;
            }
        }
    }

    /**
     * Sync window endTime from GetUserStatus resetTime.
     * If the API reports a resetTime that differs significantly from our
     * local estimate, calibrate the window endpoint.
     */
    syncWithQuotaAPI(resetTimeMs: number, quotaGroup: QuotaGroup): void {
        const window = this.windows.get(quotaGroup);
        if (!window) { return; }

        // Only calibrate if the API resetTime is within a reasonable range
        // (i.e., it's for the same window period, not a stale value)
        const drift = Math.abs(window.endTime - resetTimeMs);
        if (drift > 60_000 && resetTimeMs > Date.now()) {
            // Significant drift — trust the API
            window.endTime = resetTimeMs;
            // Recalculate startTime to maintain window duration
            window.startTime = resetTimeMs - this.windowDurationMs;
            this.dirty = true;
        }
    }

    // ── Query ─────────────────────────────────────────────────────────────

    /** Get all active windows. */
    getCurrentWindows(): Map<QuotaGroup, WindowState> {
        return this.windows;
    }

    /** Get a specific group's active window snapshot (or null). */
    getWindow(group: QuotaGroup): WindowState | null {
        return this.windows.get(group) || null;
    }

    /** Get all archived windows (read-only). */
    getArchivedWindows(): WindowState[] {
        return this.archivedWindows;
    }

    /** Get remaining time for a group's window in ms (0 if no active window). */
    getRemainingMs(group: QuotaGroup): number {
        const window = this.windows.get(group);
        if (!window) { return 0; }
        return Math.max(0, window.endTime - Date.now());
    }

    /** Get summary across all active windows. */
    getSummary(): {
        groups: Array<{
            quotaGroup: QuotaGroup;
            label: string;
            remainingMs: number;
            totalTokens: number;
            totalCost: number;
            sendCount: number;
            retryCount: number;
        }>;
    } {
        const groups: Array<{
            quotaGroup: QuotaGroup;
            label: string;
            remainingMs: number;
            totalTokens: number;
            totalCost: number;
            sendCount: number;
            retryCount: number;
        }> = [];

        for (const g of ALL_QUOTA_GROUPS) {
            const w = this.windows.get(g);
            if (!w) { continue; }
            groups.push({
                quotaGroup: g,
                label: QUOTA_GROUP_LABELS[g],
                remainingMs: Math.max(0, w.endTime - Date.now()),
                totalTokens: w.totalInputTokens + w.totalOutputTokens,
                totalCost: w.totalCost,
                sendCount: w.sendCount,
                retryCount: w.retryCount,
            });
        }

        return { groups };
    }

    // ── Persist ───────────────────────────────────────────────────────────

    /**
     * Persist to globalState if dirty.
     * Throttled: skips if called within PERSIST_THROTTLE_MS of last write.
     * Call with force=true to bypass throttle (e.g. on deactivate).
     */
    persist(force = false): void {
        if (!this.dirty) { return; }
        const now = Date.now();
        if (!force && (now - this.lastPersistTime) < PERSIST_THROTTLE_MS) {
            return;
        }

        const state: PersistedState = {
            windows: Array.from(this.windows.values()),
            archivedWindows: this.archivedWindows,
        };

        this.globalState.update(STORAGE_KEY, state);
        this.lastPersistTime = now;
        this.dirty = false;
    }

    // ── Private ───────────────────────────────────────────────────────────

    private load(): void {
        const raw = this.globalState.get<PersistedState>(STORAGE_KEY);
        if (!raw) { return; }

        // Restore active windows
        if (raw.windows) {
            for (const w of raw.windows) {
                const group = w.quotaGroup as QuotaGroup;
                if (ALL_QUOTA_GROUPS.includes(group)) {
                    this.windows.set(group, w as WindowState);
                }
            }
        }

        // Restore archived windows
        if (raw.archivedWindows) {
            this.archivedWindows = raw.archivedWindows.filter(
                (w: WindowState & { quotaGroup: string }) => ALL_QUOTA_GROUPS.includes(w.quotaGroup as QuotaGroup)
            ) as WindowState[];
        }
    }

    private createWindow(group: QuotaGroup, now: number): WindowState {
        return {
            quotaGroup: group,
            startTime: now,
            endTime: now + this.windowDurationMs,
            events: [],
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCost: 0,
            sendCount: 0,
            retryCount: 0,
            responseCount: 0,
        };
    }

    private archiveWindow(window: WindowState): void {
        // Strip events to save space in archive (keep aggregates only)
        const archived: WindowState = {
            ...window,
            events: [],  // Don't persist full events in archive
        };
        this.archivedWindows.push(archived);

        // Trim archive size
        if (this.archivedWindows.length > MAX_ARCHIVED_WINDOWS) {
            this.archivedWindows = this.archivedWindows.slice(
                this.archivedWindows.length - MAX_ARCHIVED_WINDOWS
            );
        }
    }
}
