/**
 * Synthetic `token_count` rollout lines that carry plan rate limits, shaped like Codex 0.164's
 * protocol (`codex-rs/protocol/src/protocol.rs` at tag rust-v0.164.0: `TokenCountEvent`,
 * `RateLimitSnapshot`, `RateLimitWindow`; plan types from `codex-rs/protocol/src/account.rs`).
 */
import { line } from './builders.js';

export interface WindowSpec {
  used_percent?: number;
  window_minutes?: number | null;
  /** Unix seconds. */
  resets_at?: number | null;
  /** Codex before `resets_at`: seconds after the record. */
  resets_in_seconds?: number;
}

export function rateLimits(o: {
  limit_id?: string | null;
  limit_name?: string | null;
  primary?: WindowSpec | null;
  secondary?: WindowSpec | null;
  plan_type?: string | null;
}): Record<string, unknown> {
  return {
    limit_id: o.limit_id ?? null,
    limit_name: o.limit_name ?? null,
    primary: o.primary ?? null,
    secondary: o.secondary ?? null,
    credits: { has_credits: false, unlimited: false, balance: null },
    individual_limit: null,
    spend_control_reached: null,
    plan_type: o.plan_type ?? null,
    rate_limit_reached_type: null,
  };
}

/** A `token_count` event; `limits` null is what an API-key sign-in records. */
export function tokenCountWithLimits(
  ordinal: number,
  sec: number,
  limits: Record<string, unknown> | null,
): string {
  return line('event_msg', ordinal, sec, {
    type: 'token_count',
    info: {
      last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 },
      total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 },
    },
    rate_limits: limits,
  });
}

/** A ChatGPT Plus snapshot: 5-hour and weekly windows. */
export function plusLimits(primaryUsed = 12.5, secondaryUsed = 40): Record<string, unknown> {
  return rateLimits({
    limit_id: 'codex',
    primary: { used_percent: primaryUsed, window_minutes: 300, resets_at: 1767232800 },
    secondary: { used_percent: secondaryUsed, window_minutes: 10080, resets_at: 1767744000 },
    plan_type: 'plus',
  });
}

/** Verbatim from Codex's own rollout test (`codex-rs/rollout/src/tests.rs`, rust-v0.164.0). */
export const PROTOCOL_EXAMPLE_LINE =
  '{"timestamp":"2025-01-03T12:00:00.000Z","ordinal":7,"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":null,"limit_name":null,"primary":{"used_percent":0.0,"window_minutes":60,"resets_at":1800000000},"secondary":{"used_percent":12.5,"window_minutes":10080,"resets_at":1800100000},"credits":null,"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}';
