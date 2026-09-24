import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import {
  captionLanguageOverride,
  transcribeDiscordAudio,
  transcriptionLanguage,
} from '../src/audio-transcription.js';
import type { DiscordAttachment } from '../src/discord-adapter.js';

const ENV_KEYS = [
  'DISCORD_TRANSCRIPTION_URL',
  'DISCORD_TRANSCRIPTION_CACHE_DIR',
  'DISCORD_TRANSCRIPTION_FRENCH_CHANNELS',
  'DISCORD_TRANSCRIPTION_TIMEOUT_MS',
  'DISCORD_TRANSCRIPTION_MAX_BYTES',
  'DISCORD_TRANSCRIPTION_ENGINE',
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('selects French by channel, English elsewhere, and honors a leading override', () => {
  assert.equal(transcriptionLanguage('petit', '', 'petit,courrier'), 'fr');
  assert.equal(transcriptionLanguage('general', '', 'petit,courrier'), 'en');
  assert.equal(transcriptionLanguage('petit', '[en] one English note', 'petit,courrier'), 'en');
  assert.equal(transcriptionLanguage('general', ' [FR] un mot', 'petit,courrier'), 'fr');
  assert.equal(captionLanguageOverride('quoted [fr] later'), null);
});

test('downloads, transcribes, and then reuses the shared attachment cache', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'discord-transcription-'));
  process.env.DISCORD_TRANSCRIPTION_URL = 'http://127.0.0.1:7350/inference';
  process.env.DISCORD_TRANSCRIPTION_CACHE_DIR = cacheDir;
  process.env.DISCORD_TRANSCRIPTION_FRENCH_CHANNELS = 'courrier';
  process.env.DISCORD_TRANSCRIPTION_ENGINE = 'test-whisper';

  const attachment: DiscordAttachment = {
    id: 'voice-123',
    name: 'voice-message.ogg',
    url: 'https://cdn.discord.test/voice.ogg',
    contentType: 'audio/ogg',
    size: 4,
  };
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://cdn.')) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { 'content-length': '4' },
      });
    }
    return Response.json({ text: '  Bonjour   Ian.\n' });
  }) as typeof fetch;

  const first = await transcribeDiscordAudio(
    attachment,
    { channelId: 'courrier', caption: '' },
    { fetchImpl: fakeFetch, now: () => new Date('2026-08-26T17:00:00Z') },
  );
  assert.equal(first?.transcript, 'Bonjour Ian.');
  assert.equal(first?.languageHint, 'fr');
  assert.equal(first?.cached, false);
  assert.equal(calls.length, 2);

  const second = await transcribeDiscordAudio(
    attachment,
    { channelId: 'courrier', caption: '' },
    { fetchImpl: fakeFetch },
  );
  assert.equal(second?.transcript, 'Bonjour Ian.');
  assert.equal(second?.cached, true);
  assert.equal(calls.length, 2, 'cache hit performs no network or inference calls');
});
