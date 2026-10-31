import { MAIN_AGENT_ID } from '../core/model.js';
import { emptyUsage, sumUsage } from '../core/usage.js';
const MIN = 60_000;
/**
 * Claude Code's five-hour window ends up mostly the open demo session's, with a tail of others;
 * Codex's, between two sessions. Every one ends before any window the demo's quotas report began
 * less than 2 hours ago.
 */
const BURNERS = [
    {
        agent: 'claude-code',
        model: 'claude-opus-5-5',
        title: 'Tidy the checkout form',
        project: 'shopfront',
        from: 140,
        to: 95,
        tokens: 520_000,
    },
    {
        agent: 'claude-code',
        model: 'claude-opus-5-5',
        title: 'Write the release notes',
        project: 'blog',
        from: 110,
        to: 80,
        tokens: 300_000,
    },
    {
        agent: 'opencode',
        model: 'claude-sonnet-5-5',
        title: 'Rename the deploy jobs',
        project: 'infra',
        from: 90,
        to: 70,
        tokens: 180_000,
    },
    {
        agent: 'claude-code',
        model: 'claude-opus-5-5',
        title: 'Why is the cache cold',
        project: 'infra',
        from: 75,
        to: 50,
        tokens: 110_000,
    },
    {
        agent: 'claude-code',
        model: 'claude-haiku-5-5',
        title: 'Sort the shell aliases',
        project: 'dotfiles',
        from: 60,
        to: 45,
        tokens: 60_000,
    },
    {
        agent: 'claude-code',
        model: 'claude-haiku-5-5',
        title: 'Fix a typo in the README',
        project: 'notes',
        from: 40,
        to: 35,
        tokens: 30_000,
    },
    {
        agent: 'codex',
        model: 'gpt-5.5-codex',
        title: 'Port the price table',
        project: 'shopfront',
        from: 100,
        to: 40,
        tokens: 410_000,
    },
    {
        agent: 'codex',
        model: 'gpt-5.5-codex',
        title: 'Add the sitemap',
        project: 'blog',
        from: 70,
        to: 30,
        tokens: 160_000,
    },
];
/** Requests each session makes. */
const REQUESTS = 6;
const iso = (t) => new Date(t).toISOString();
/** `tokens` as a Claude-like mix: mostly cache reads; none written for an OpenAI-style API. */
function mix(tokens, writesCache) {
    const cacheWrite = writesCache ? Math.round(tokens * 0.07) : 0;
    const input = Math.round(tokens * 0.03);
    const output = Math.round(tokens * 0.05);
    return {
        ...emptyUsage(),
        input,
        cacheRead: tokens - cacheWrite - input - output,
        cacheWrite,
        cacheWrite5m: cacheWrite,
        output,
        thinking: Math.round(output * 0.4),
    };
}
function build(b, n, now) {
    const start = now - b.from * MIN;
    const end = now - b.to * MIN;
    const nativeId = `demo-burn-${String(n).padStart(2, '0')}`;
    const id = `${b.agent}:${nativeId}`;
    const writesCache = b.agent !== 'codex';
    const requests = Array.from({ length: REQUESTS }, (_, i) => {
        const at = start + ((end - start) * i) / REQUESTS;
        return {
            id: `${nativeId}-r${i + 1}`,
            agentId: MAIN_AGENT_ID,
            turnId: null,
            index: i + 1,
            model: b.model,
            effort: null,
            startedAt: iso(at),
            firstBlockAt: iso(at + 4_000),
            endedAt: iso(at + 20_000),
            status: 'complete',
            stopReason: 'end_turn',
            usage: mix(Math.round(b.tokens / REQUESTS), writesCache),
            blocks: [],
            toolCallIds: [],
            hasDetail: false,
            error: null,
        };
    });
    const usage = sumUsage(requests.map((r) => r.usage));
    const cwd = `/Users/demo/Dev/${b.project}`;
    const session = {
        id,
        agent: b.agent,
        nativeId,
        title: b.title,
        cwd,
        project: b.project,
        startedAt: iso(start),
        updatedAt: iso(end),
        live: 'closed',
        version: null,
        model: b.model,
        usage,
        counts: { turns: 0, requests: REQUESTS, toolCalls: 0, agents: 1 },
    };
    return {
        session,
        agents: [],
        turns: [],
        requests,
        toolCalls: [],
        workflows: [],
        diagnostics: { unknownRecordTypes: {}, parseErrors: 0, unavailable: [] },
    };
}
/** The sessions, placed relative to `now` (epoch ms). */
export function createDemoBurn(now) {
    return BURNERS.map((b, i) => build(b, i + 1, now));
}
//# sourceMappingURL=quota-burn-demo.js.map