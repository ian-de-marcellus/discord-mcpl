/**
 * Idempotent publish helpers: per-part Discord nonces derived from the host's
 * idempotencyKey, and the small marker a late delivery carries.
 *
 * The host (agent-framework's prose outbox) sends `idempotencyKey` and
 * `writtenAt` on channels/publish. A retry of the same speech carries the
 * same key, so:
 *   - within Discord's nonce window (a few minutes), `enforce_nonce` makes
 *     Discord itself return the original message instead of posting again;
 *   - within this process's life, the key → result cache answers directly;
 *   - after a restart, the channel's recent history is checked for the parts
 *     this bot already posted, and only the rest is sent.
 */
import { createHash } from 'node:crypto';

/** Discord nonces are at most 25 characters. */
export function nonceFor(idempotencyKey: string, part: number): string {
  return createHash('sha256').update(`${idempotencyKey}:${part}`).digest('base64url').slice(0, 25);
}

/** A delivery this long after the speech was written gets the marker. */
export const LATE_AFTER_MS = 2 * 60_000;

/** Why a retry is late, as the host saw it (channels/publish delayReason). */
export type DelayReason = 'disconnected' | 'unanswered';

const REASON_TEXT: Record<DelayReason, string> = {
  disconnected: 'connection was down',
  unanswered: 'a send timed out',
};

/**
 * First line of a late delivery. It records only what the channel can't
 * show: when the words were written (Discord already shows when they
 * arrived, so no "late" judgement) and why the silence wasn't a choice.
 * `<t:…:t>` renders in each reader's own time zone. Wording from the
 * Librarian, 2026-09-25.
 */
export function lateMarker(writtenAtMs: number, reason?: DelayReason): string {
  const why = reason ? ` · ${REASON_TEXT[reason]}` : '';
  return `-# written <t:${Math.floor(writtenAtMs / 1000)}:t>${why}\n`;
}

const LATE_MARKER_LINE = /^-# written <t:\d+:t>(?: · [^\n]*)?\n/;

export function parseDelayReason(v: unknown): DelayReason | undefined {
  return v === 'disconnected' || v === 'unanswered' ? v : undefined;
}

/** Message content as it was before a late marker was added. */
export function stripLateMarker(content: string): string {
  return content.replace(LATE_MARKER_LINE, '');
}

/** Discord snowflake for a moment (for `messages.fetch({ after })`). */
export function snowflakeAt(ms: number): string {
  const DISCORD_EPOCH = 1_420_070_400_000n;
  const t = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH;
  return (t < 0n ? 0n : t << 22n).toString();
}

/** Keys are host-generated ids; refuse anything implausible. */
export function validIdempotencyKey(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : undefined;
}

/** Parse the host's ISO writtenAt; undefined if absent or invalid. */
export function parseWrittenAt(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}
