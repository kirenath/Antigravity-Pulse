// ─── Model → Quota Group Mapping ─────────────────────────────────────────────
// Maps Antigravity model IDs to one of 3 quota groups for 5h window tracking.
// Based on cockpit HISTORY_GROUPS definitions.
//
// Copyright (c) 2024 lalalavir. MIT License.

// ─── Types ────────────────────────────────────────────────────────────────────

export type QuotaGroup = 'gemini-pro' | 'gemini-flash' | 'claude-gpt';

export const QUOTA_GROUP_LABELS: Record<QuotaGroup, string> = {
    'gemini-pro': 'Gemini Pro',
    'gemini-flash': 'Gemini Flash',
    'claude-gpt': 'Claude + GPT',
};

export const ALL_QUOTA_GROUPS: QuotaGroup[] = ['gemini-pro', 'gemini-flash', 'claude-gpt'];

// ─── Exact Model ID → Group Mapping ──────────────────────────────────────────
// Sources: cockpit HISTORY_GROUPS + recommended_models.ts

const MODEL_GROUP_MAP: Record<string, QuotaGroup> = {
    // Gemini Pro group (M7, M8, M36, M37)
    'MODEL_PLACEHOLDER_M7': 'gemini-pro',
    'MODEL_PLACEHOLDER_M8': 'gemini-pro',
    'MODEL_PLACEHOLDER_M36': 'gemini-pro',   // Gemini 3.1 Pro (Low)
    'MODEL_PLACEHOLDER_M37': 'gemini-pro',   // Gemini 3.1 Pro (High)

    // Gemini Flash group (M18)
    'MODEL_PLACEHOLDER_M18': 'gemini-flash',  // Gemini 3 Flash

    // Claude + GPT group (M12, M26, M35, GPT-OSS)
    'MODEL_PLACEHOLDER_M12': 'claude-gpt',
    'MODEL_CLAUDE_4_5_SONNET': 'claude-gpt',
    'MODEL_CLAUDE_4_5_SONNET_THINKING': 'claude-gpt',
    'MODEL_PLACEHOLDER_M26': 'claude-gpt',   // Claude Opus 4.6 (Thinking)
    'MODEL_PLACEHOLDER_M35': 'claude-gpt',   // Claude Sonnet 4.6 (Thinking)
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 'claude-gpt',
};

// ─── Matcher Fallbacks ────────────────────────────────────────────────────────
// Regex-based matchers for future model IDs not yet in the hardcoded map.
// Mirrors cockpit's isGeminiProTier / isGeminiFlash / isClaudeFamily patterns.

interface MatchInput {
    modelIdLower: string;
}

const MATCHERS: Array<{ group: QuotaGroup; match: (input: MatchInput) => boolean }> = [
    {
        group: 'gemini-pro',
        match: ({ modelIdLower }) =>
            /^gemini-\d+(?:\.\d+)?-pro-(high|low)(?:-|$)/.test(modelIdLower) ||
            /model_placeholder_m(7|8|36|37)\b/.test(modelIdLower) ||
            /model_google_gemini_\d+_\d+_pro\b/.test(modelIdLower),
    },
    {
        group: 'gemini-flash',
        match: ({ modelIdLower }) =>
            /^gemini-\d+(?:\.\d+)?-flash(?:-|$)/.test(modelIdLower) ||
            /model_google_gemini_\d+_\d+_flash\b/.test(modelIdLower),
    },
    {
        group: 'claude-gpt',
        match: ({ modelIdLower }) =>
            modelIdLower.startsWith('claude-') ||
            modelIdLower.startsWith('model_claude') ||
            modelIdLower.startsWith('model_anthropic') ||
            modelIdLower.includes('openai') ||
            modelIdLower.includes('gpt'),
    },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the quota group for a model ID.
 * Returns null for unrecognized models (e.g., image-gen models, auxiliary models).
 */
export function getQuotaGroup(modelId: string): QuotaGroup | null {
    // 1. Exact match (fast path)
    const exact = MODEL_GROUP_MAP[modelId];
    if (exact) { return exact; }

    // 2. Matcher fallback (for unknown future model IDs)
    const lower = modelId.toLowerCase();
    for (const { group, match } of MATCHERS) {
        if (match({ modelIdLower: lower })) {
            return group;
        }
    }

    return null;
}
