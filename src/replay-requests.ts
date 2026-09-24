/**
 * Operator replay requests (DISCORD_REPLAY_FILE): re-deliver a range of a
 * channel's history through the ordinary delivery path, once. For restoring
 * messages an agent should have received but didn't (a delivery bug, a
 * filter mistake, an outage longer than the catch-up window).
 *
 * File format — a JSON array of:
 *   { channelId, afterMessageId, throughMessageId?, wake?, limit?, note? }
 * Processed requests are marked in place: { done: true, delivered, deliveredAt }.
 */
export interface ReplayRequest {
  channelId: string;
  afterMessageId: string;
  throughMessageId?: string;
  /** Default false: replayed messages are tagged chat:replayed and carry a
   *  suppressWake hint. */
  wake?: boolean;
  /** Messages to fetch after afterMessageId (1–300, default 100). */
  limit?: number;
  note?: string;
  done?: boolean;
  delivered?: number;
  deliveredAt?: string;
}

/** Pending, well-formed requests (index into the original array kept so the
 *  caller can mark them done in place). Malformed entries are skipped. */
export function pendingReplayRequests(raw: unknown): Array<{ index: number; request: ReplayRequest }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ index: number; request: ReplayRequest }> = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const r = entry as Record<string, unknown>;
    if (r.done === true) return;
    if (typeof r.channelId !== 'string' || !/^\d+$/.test(r.channelId)) return;
    if (typeof r.afterMessageId !== 'string' || !/^\d+$/.test(r.afterMessageId)) return;
    if (r.throughMessageId !== undefined && (typeof r.throughMessageId !== 'string' || !/^\d+$/.test(r.throughMessageId))) return;
    const limit = typeof r.limit === 'number' && Number.isFinite(r.limit) ? Math.min(300, Math.max(1, Math.floor(r.limit))) : 100;
    out.push({ index, request: { ...(r as unknown as ReplayRequest), limit } });
  });
  return out;
}

/** Oldest-first messages to replay: after the anchor (fetch already bounds
 *  that), up to throughMessageId, excluding the bot's own messages and any
 *  caller-specified skips. */
export function selectReplayMessages<T extends { id: string; authorId: string; timestamp: Date }>(
  history: T[],
  opts: { botId: string | null; throughMessageId?: string; skip?: (m: T) => boolean },
): T[] {
  const through = opts.throughMessageId ? BigInt(opts.throughMessageId) : null;
  return [...history]
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .filter((m) => m.authorId !== opts.botId && !(opts.skip?.(m) ?? false))
    .filter((m) => through === null || BigInt(m.id) <= through);
}
