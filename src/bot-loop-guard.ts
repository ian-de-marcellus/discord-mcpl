import { dirname } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

interface ChannelLoopState {
  consecutiveTurns: number;
  lastBotAuthorId: string | null;
  updatedAt: string;
}

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
}

export interface BotLoopGuardDecision {
  allow: boolean;
  consecutiveTurns: number;
  reset: boolean;
  sameTurn: boolean;
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
  const updatedAt = (input.now ?? new Date()).toISOString();

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

  const sameTurn = previous.lastBotAuthorId === input.authorId;
  const consecutiveTurns = sameTurn
    ? previous.consecutiveTurns
    : previous.consecutiveTurns + 1;
  state.channels[input.channelId] = {
    consecutiveTurns,
    lastBotAuthorId: input.authorId,
    updatedAt,
  };
  writeState(input.statePath, state);

  return {
    allow: consecutiveTurns <= input.maxTurns,
    consecutiveTurns,
    reset: false,
    sameTurn,
  };
}
