import { dirname } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

interface ChannelLoopState {
  consecutiveTurns: number;
  lastBotAuthorId: string | null;
  updatedAt: string;
  /** When the current run of bot turns began. Absent in older state files
   *  (updatedAt stands in). */
  runStartedAt?: string;
}

/** A run of bot turns older than this starts over: the guard exists to stop
 *  rapid ping-pong (hundreds of messages an hour), not slow multi-day
 *  exchanges. Without it, a run that tripped once stays tripped until a
 *  human happens to post in the channel (observed: 11 days of one bot's
 *  daily messages silently held). */
export const BOT_LOOP_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

interface BotLoopStateFile {
  version: 1;
  channels: Record<string, ChannelLoopState>;
}

export interface BotLoopGuardInput {
  statePath: string;
  channelId: string;
  authorId: string;
  isBot: boolean;
  maxTurns: number;
  now?: Date;
  /** Override BOT_LOOP_RUN_WINDOW_MS (tests / tuning). */
  runWindowMs?: number;
}

export interface BotLoopGuardDecision {
  allow: boolean;
  consecutiveTurns: number;
  reset: boolean;
  sameTurn: boolean;
  /** True when this message started a fresh run because the previous one aged out. */
  expired?: boolean;
}

function emptyState(): BotLoopStateFile {
  return { version: 1, channels: {} };
}

function readState(path: string): BotLoopStateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BotLoopStateFile>;
    if (parsed.version !== 1 || !parsed.channels || typeof parsed.channels !== 'object') {
      return emptyState();
    }
    return { version: 1, channels: parsed.channels as Record<string, ChannelLoopState> };
  } catch {
    return emptyState();
  }
}

function writeState(path: string, state: BotLoopStateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2) + '\n');
  renameSync(tempPath, path);
}

/**
 * Maintain a shared per-channel run of bot-authored turns.
 *
 * Every bot bridge points at the same state file. A bot-authored Discord
 * message is observed only by the receiving bridge (the sender drops its own
 * gateway echo), so the shared count advances exactly once per cross-agent
 * hop. Consecutive chunks from the same author count as one turn. Any human
 * message in the channel resets the run.
 */
export function applyBotLoopGuard(input: BotLoopGuardInput): BotLoopGuardDecision {
  const state = readState(input.statePath);
  const previous = state.channels[input.channelId] ?? {
    consecutiveTurns: 0,
    lastBotAuthorId: null,
    updatedAt: '',
  };
  const now = input.now ?? new Date();
  const updatedAt = now.toISOString();

  if (!input.isBot) {
    const reset = previous.consecutiveTurns > 0 || previous.lastBotAuthorId !== null;
    if (reset) {
      state.channels[input.channelId] = {
        consecutiveTurns: 0,
        lastBotAuthorId: null,
        updatedAt,
      };
      writeState(input.statePath, state);
    }
    return { allow: true, consecutiveTurns: 0, reset, sameTurn: false };
  }

  const windowMs = input.runWindowMs ?? BOT_LOOP_RUN_WINDOW_MS;
  const runStart = Date.parse(previous.runStartedAt ?? previous.updatedAt);
  const expired = previous.consecutiveTurns > 0 &&
    Number.isFinite(runStart) && now.getTime() - runStart > windowMs;
  const base = expired ? { consecutiveTurns: 0, lastBotAuthorId: null } : previous;
  const sameTurn = base.lastBotAuthorId === input.authorId;
  const consecutiveTurns = sameTurn
    ? base.consecutiveTurns
    : base.consecutiveTurns + 1;
  state.channels[input.channelId] = {
    consecutiveTurns,
    lastBotAuthorId: input.authorId,
    updatedAt,
    runStartedAt: expired || base.consecutiveTurns === 0
      ? updatedAt
      : (previous.runStartedAt ?? previous.updatedAt),
  };
  writeState(input.statePath, state);

  return {
    allow: consecutiveTurns <= input.maxTurns,
    consecutiveTurns,
    reset: false,
    sameTurn,
    ...(expired ? { expired: true } : {}),
  };
}
