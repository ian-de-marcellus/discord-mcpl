import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { DiscordAttachment } from './discord-adapter.js';

export type TranscriptionLanguage = 'fr' | 'en';

export interface AudioTranscriptionContext {
  channelId: string;
  caption: string;
}

export interface AudioTranscriptionResult {
  transcript: string;
  languageHint: TranscriptionLanguage;
  engine: string;
  cached: boolean;
  audioCachePath: string;
}

interface CachedTranscription {
  schema: 'discord-audio-transcription/v1';
  attachmentId: string;
  languageHint: TranscriptionLanguage;
  engine: string;
  transcript: string;
  transcribedAt: string;
  audioFile: string;
}

interface TranscriptionConfig {
  endpoint: string;
  cacheDir: string;
  language: TranscriptionLanguage;
  engine: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface AudioTranscriptionOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

function boundedPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** A leading caption marker deliberately overrides the channel default. */
export function captionLanguageOverride(caption: string): TranscriptionLanguage | null {
  const match = /^\s*\[(fr|en)\](?:\s|$)/i.exec(caption);
  return match ? match[1]!.toLowerCase() as TranscriptionLanguage : null;
}

export function transcriptionLanguage(
  channelId: string,
  caption: string,
  frenchChannelsRaw = process.env.DISCORD_TRANSCRIPTION_FRENCH_CHANNELS ?? '',
): TranscriptionLanguage {
  const override = captionLanguageOverride(caption);
  if (override) return override;
  const frenchChannels = new Set(
    frenchChannelsRaw.split(',').map((value) => value.trim()).filter(Boolean),
  );
  return frenchChannels.has(channelId) ? 'fr' : 'en';
}

function configFor(context: AudioTranscriptionContext): TranscriptionConfig | null {
  const endpoint = process.env.DISCORD_TRANSCRIPTION_URL?.trim();
  const cacheDir = process.env.DISCORD_TRANSCRIPTION_CACHE_DIR?.trim();
  if (!endpoint || !cacheDir) return null;
  return {
    endpoint,
    cacheDir,
    language: transcriptionLanguage(context.channelId, context.caption),
    engine: process.env.DISCORD_TRANSCRIPTION_ENGINE?.trim()
      || 'whisper.cpp/large-v3-turbo-q5_0',
    timeoutMs: boundedPositiveInt(
      process.env.DISCORD_TRANSCRIPTION_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    maxBytes: boundedPositiveInt(
      process.env.DISCORD_TRANSCRIPTION_MAX_BYTES,
      DEFAULT_MAX_BYTES,
    ),
  };
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.audio';
}

function readCached(path: string, expectedLanguage: TranscriptionLanguage): CachedTranscription | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CachedTranscription;
    if (
      parsed.schema !== 'discord-audio-transcription/v1'
      || parsed.languageHint !== expectedLanguage
      || typeof parsed.transcript !== 'string'
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function atomicWrite(path: string, data: string | Uint8Array): void {
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, data);
  renameSync(tempPath, path);
}

function acquireLock(path: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cachedResult(
  cacheDir: string,
  cached: CachedTranscription,
  fromCache: boolean,
): AudioTranscriptionResult {
  return {
    transcript: cached.transcript,
    languageHint: cached.languageHint,
    engine: cached.engine,
    cached: fromCache,
    audioCachePath: join(cacheDir, cached.audioFile),
  };
}

/**
 * Download and transcribe one Discord audio attachment, once across all bot
 * processes sharing the cache. The immutable Discord attachment id is the
 * cache key; language is included because an explicit caption override can
 * legitimately request a different decoding of the same bytes.
 */
export async function transcribeDiscordAudio(
  attachment: DiscordAttachment,
  context: AudioTranscriptionContext,
  options: AudioTranscriptionOptions = {},
): Promise<AudioTranscriptionResult | null> {
  const config = configFor(context);
  if (!config) return null;
  if (attachment.size > config.maxBytes) {
    throw new Error(`audio is over the ${config.maxBytes}-byte transcription cap`);
  }

  mkdirSync(config.cacheDir, { recursive: true });
  const stem = `${attachment.id}-${config.language}`;
  const transcriptPath = join(config.cacheDir, `${stem}.json`);
  const lockPath = join(config.cacheDir, `${stem}.lock`);
  const audioFile = `${attachment.id}${safeExtension(attachment.name)}`;
  const audioPath = join(config.cacheDir, audioFile);
  const deadline = Date.now() + config.timeoutMs;

  // Another residence may receive the same #courrier event simultaneously.
  // Wait for its cache result; if it fails and releases the lock, take over.
  let ownsLock = false;
  while (!ownsLock) {
    const cached = readCached(transcriptPath, config.language);
    if (cached) return cachedResult(config.cacheDir, cached, true);
    ownsLock = acquireLock(lockPath);
    if (ownsLock) break;
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for the shared transcription cache');
    }
    await delay(200);
  }

  try {
    // Recheck after taking the lock in case the prior owner finished between
    // the last cache read and our successful open(O_EXCL).
    const cached = readCached(transcriptPath, config.language);
    if (cached) return cachedResult(config.cacheDir, cached, true);

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const downloadCtrl = new AbortController();
    const downloadTimer = setTimeout(() => downloadCtrl.abort(), config.timeoutMs);
    let audio: Uint8Array;
    try {
      const response = await fetchImpl(attachment.url, { signal: downloadCtrl.signal });
      if (!response.ok) throw new Error(`audio download returned HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > config.maxBytes) {
        throw new Error(`audio download is over the ${config.maxBytes}-byte transcription cap`);
      }
      audio = new Uint8Array(await response.arrayBuffer());
      if (audio.byteLength > config.maxBytes) {
        throw new Error(`audio download is over the ${config.maxBytes}-byte transcription cap`);
      }
    } finally {
      clearTimeout(downloadTimer);
    }

    if (!existsSync(audioPath)) atomicWrite(audioPath, audio);

    const form = new FormData();
    form.append(
      'file',
      new Blob([audio], { type: attachment.contentType || 'application/octet-stream' }),
      attachment.name,
    );
    form.append('language', config.language);
    form.append('temperature', '0.0');
    form.append('response_format', 'json');

    const inferenceCtrl = new AbortController();
    const inferenceTimer = setTimeout(() => inferenceCtrl.abort(), config.timeoutMs);
    let payload: unknown;
    try {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        body: form,
        signal: inferenceCtrl.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`local transcription returned HTTP ${response.status}: ${detail}`);
      }
      payload = await response.json();
    } finally {
      clearTimeout(inferenceTimer);
    }

    const text = payload && typeof payload === 'object'
      ? (payload as { text?: unknown }).text
      : null;
    if (typeof text !== 'string') throw new Error('local transcription returned no text field');

    const record: CachedTranscription = {
      schema: 'discord-audio-transcription/v1',
      attachmentId: attachment.id,
      languageHint: config.language,
      engine: config.engine,
      transcript: normalizeTranscript(text),
      transcribedAt: (options.now ?? (() => new Date()))().toISOString(),
      audioFile,
    };
    atomicWrite(transcriptPath, JSON.stringify(record, null, 2) + '\n');
    return cachedResult(config.cacheDir, record, false);
  } finally {
    try { unlinkSync(lockPath); } catch { /* already released or cleaned up */ }
  }
}
