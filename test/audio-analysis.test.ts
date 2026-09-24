import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import {
  analyzeDiscordAudio,
  type AudioCommandRunner,
} from '../src/audio-analysis.js';

const ENV_KEYS = [
  'DISCORD_AUDIO_ANALYSIS_ENABLED',
  'DISCORD_AUDIO_ANALYSIS_CACHE_DIR',
  'DISCORD_AUDIO_FFMPEG_PATH',
  'DISCORD_AUDIO_FFPROBE_PATH',
  'DISCORD_AUDIO_ANALYSIS_TIMEOUT_MS',
  'DISCORD_AUDIO_ANALYSIS_MAX_BYTES',
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('is opt-in per residence', async () => {
  delete process.env.DISCORD_AUDIO_ANALYSIS_ENABLED;
  assert.equal(await analyzeDiscordAudio('voice-disabled', '/does/not/exist.ogg'), null);
});

test('generates a spectrogram and numeric summary from MP3, then reuses both from cache', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'discord-audio-analysis-'));
  const audioPath = join(cacheDir, 'recording.mp3');
  writeFileSync(audioPath, new Uint8Array([1, 2, 3, 4]));
  process.env.DISCORD_AUDIO_ANALYSIS_ENABLED = 'true';
  process.env.DISCORD_AUDIO_ANALYSIS_CACHE_DIR = cacheDir;
  process.env.DISCORD_AUDIO_FFMPEG_PATH = '/test/ffmpeg';
  process.env.DISCORD_AUDIO_FFPROBE_PATH = '/test/ffprobe';

  const calls: Array<{ executable: string; args: string[] }> = [];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const fakeRunner: AudioCommandRunner = async (executable, args) => {
    calls.push({ executable, args });
    if (executable.endsWith('ffprobe')) {
      return {
        stdout: JSON.stringify({
          streams: [{
            codec_name: 'mp3',
            codec_type: 'audio',
            sample_rate: '48000',
            channels: 1,
            channel_layout: 'mono',
          }],
          format: {
            format_name: 'mp3',
            duration: '12.500000',
            bit_rate: '32000',
          },
        }),
        stderr: '',
      };
    }
    const filter = args[args.indexOf('-af') + 1] ?? '';
    if (filter.includes('ebur128=')) {
      return {
        stdout: '',
        stderr:
          'Summary:\n\n' +
          '  Integrated loudness:\n    I:         -24.5 LUFS\n\n' +
          '  Loudness range:\n    LRA:         4.2 LU\n\n' +
          '  True peak:\n    Peak:       -3.1 dBFS\n',
      };
    }
    if (filter.includes('astats=')) {
      return {
        stdout: '',
        stderr:
          'RMS level dB: -25.250000\n' +
          'Crest factor: 8.500000\n' +
          'Zero crossings rate: 0.075000\n',
      };
    }
    if (filter.includes('silencedetect=')) {
      return {
        stdout: '',
        stderr:
          'silence_start: 0\n' +
          'silence_end: 1.5 | silence_duration: 1.5\n' +
          'silence_start: 10.0\n' +
          'silence_end: 12.0 | silence_duration: 2.0\n',
      };
    }
    if (filter.includes('aspectralstats=')) {
      return {
        stdout:
          'lavfi.aspectralstats.1.centroid=800\n' +
          'lavfi.aspectralstats.1.rolloff=1900\n' +
          'lavfi.aspectralstats.1.flatness=0.1\n' +
          'lavfi.aspectralstats.1.centroid=1200\n' +
          'lavfi.aspectralstats.1.rolloff=2500\n' +
          'lavfi.aspectralstats.1.flatness=0.2\n' +
          'lavfi.aspectralstats.1.centroid=1800\n' +
          'lavfi.aspectralstats.1.rolloff=3100\n' +
          'lavfi.aspectralstats.1.flatness=0.3\n',
        stderr: '',
      };
    }
    if (args.includes('-filter_complex')) {
      writeFileSync(args.at(-1)!, png);
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected test command: ${executable} ${args.join(' ')}`);
  };

  const first = await analyzeDiscordAudio(
    'voice-456',
    audioPath,
    { runCommand: fakeRunner, now: () => new Date('2026-08-30T04:00:00Z') },
  );
  assert.ok(first);
  assert.equal(first.cached, false);
  assert.equal(first.spectrogramMimeType, 'image/png');
  assert.equal(first.spectrogramData, png.toString('base64'));
  assert.match(first.summary, /duration: 12\.50 s/);
  assert.match(first.summary, /format: mp3, mp3/);
  assert.match(first.summary, /-24\.5 LUFS integrated/);
  assert.match(first.summary, /3\.50 s at or below -45 dBFS/);
  assert.match(first.summary, /28\.0%; 2 interval\(s\)/);
  assert.match(first.summary, /spectral centroid median 1\.20 kHz/);
  assert.match(first.summary, /85% roll-off median 2\.50 kHz/);
  assert.match(first.summary, /no speaker, emotion, or intent inference/);
  assert.equal(calls.length, 6);

  const second = await analyzeDiscordAudio(
    'voice-456',
    audioPath,
    { runCommand: fakeRunner },
  );
  assert.ok(second);
  assert.equal(second.cached, true);
  assert.equal(second.summary, first.summary);
  assert.equal(second.spectrogramData, first.spectrogramData);
  assert.equal(calls.length, 6, 'cache hit does not invoke ffmpeg or ffprobe');
});
