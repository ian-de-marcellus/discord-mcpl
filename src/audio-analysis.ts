import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  timeoutMs: number;
  maxBuffer: number;
}

export type AudioCommandRunner = (
  executable: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>;

interface AudioAnalysisConfig {
  cacheDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  timeoutMs: number;
  maxBytes: number;
}

interface AudioFormatSummary {
  durationSeconds: number;
  container?: string;
  codec?: string;
  sampleRateHz?: number;
  channels?: number;
  channelLayout?: string;
  bitrateKbps?: number;
}

interface AudioLevelSummary {
  integratedLufs?: number;
  loudnessRangeLu?: number;
  truePeakDbfs?: number;
  rmsDbfs?: number;
  crestFactor?: number;
}

interface AudioTimingSummary {
  silenceThresholdDbfs: number;
  minimumSilenceSeconds: number;
  silenceSeconds: number;
  silenceFraction: number;
  silenceIntervals: number;
  zeroCrossingRate?: number;
}

interface AudioSpectrumSummary {
  analysisSampleRateHz: number;
  frames: number;
  centroidMedianHz?: number;
  centroidP10Hz?: number;
  centroidP90Hz?: number;
  rolloffMedianHz?: number;
  flatnessMedian?: number;
}

interface CachedAudioAnalysis {
  schema: 'discord-audio-analysis/v1';
  attachmentId: string;
  analyzedAt: string;
  analyzer: 'ffmpeg';
  sourceAudioFile: string;
  spectrogramFile: string;
  format: AudioFormatSummary;
  level: AudioLevelSummary;
  timing: AudioTimingSummary;
  spectrum: AudioSpectrumSummary;
}

export interface AudioAnalysisResult {
  summary: string;
  spectrogramData: string;
  spectrogramMimeType: 'image/png';
  cached: boolean;
}

export interface AudioAnalysisOptions {
  runCommand?: AudioCommandRunner;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
const SILENCE_THRESHOLD_DBFS = -45;
const MINIMUM_SILENCE_SECONDS = 0.25;
const SPECTRUM_SAMPLE_RATE_HZ = 16_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function enabled(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(raw?.trim() ?? '');
}

function boundedPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function configFor(audioPath: string): AudioAnalysisConfig | null {
  if (!enabled(process.env.DISCORD_AUDIO_ANALYSIS_ENABLED)) return null;
  return {
    cacheDir: process.env.DISCORD_AUDIO_ANALYSIS_CACHE_DIR?.trim() || dirname(audioPath),
    ffmpegPath: process.env.DISCORD_AUDIO_FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: process.env.DISCORD_AUDIO_FFPROBE_PATH?.trim() || 'ffprobe',
    timeoutMs: boundedPositiveInt(
      process.env.DISCORD_AUDIO_ANALYSIS_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    maxBytes: boundedPositiveInt(
      process.env.DISCORD_AUDIO_ANALYSIS_MAX_BYTES,
      DEFAULT_MAX_BYTES,
    ),
  };
}

function defaultCommandRunner(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }
        const detail = (stderr || error.message).trim().slice(-1200);
        reject(new Error(`${basename(executable)} failed: ${detail}`));
      },
    );
  });
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

function isPng(path: string): boolean {
  try {
    const data = readFileSync(path);
    return data.byteLength >= PNG_SIGNATURE.byteLength
      && data.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE);
  } catch {
    return false;
  }
}

function readCached(
  recordPath: string,
  cacheDir: string,
  attachmentId: string,
): CachedAudioAnalysis | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as CachedAudioAnalysis;
    if (
      parsed.schema !== 'discord-audio-analysis/v1'
      || parsed.attachmentId !== attachmentId
      || parsed.analyzer !== 'ffmpeg'
      || !parsed.format
      || typeof parsed.format.durationSeconds !== 'number'
      || !parsed.level
      || !parsed.timing
      || !parsed.spectrum
      || typeof parsed.spectrogramFile !== 'string'
      || basename(parsed.spectrogramFile) !== parsed.spectrogramFile
    ) return null;
    const spectrogramPath = join(cacheDir, parsed.spectrogramFile);
    return isPng(spectrogramPath) ? parsed : null;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match ? finiteNumber(match[1]) : undefined;
}

function parseProbe(stdout: string): AudioFormatSummary {
  const payload = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const stream = payload.streams?.find((entry) => entry.codec_type === 'audio')
    ?? payload.streams?.[0];
  const durationSeconds = finiteNumber(payload.format?.duration);
  if (durationSeconds === undefined || durationSeconds < 0 || !stream) {
    throw new Error('ffprobe returned no usable audio stream or duration');
  }
  const bitrate = finiteNumber(payload.format?.bit_rate);
  return {
    durationSeconds,
    container: typeof payload.format?.format_name === 'string'
      ? payload.format.format_name
      : undefined,
    codec: typeof stream.codec_name === 'string' ? stream.codec_name : undefined,
    sampleRateHz: finiteNumber(stream.sample_rate),
    channels: finiteNumber(stream.channels),
    channelLayout: typeof stream.channel_layout === 'string'
      ? stream.channel_layout
      : undefined,
    bitrateKbps: bitrate === undefined ? undefined : bitrate / 1000,
  };
}

function parseEbur128(stderr: string): Pick<
  AudioLevelSummary,
  'integratedLufs' | 'loudnessRangeLu' | 'truePeakDbfs'
> {
  const summary = stderr.slice(Math.max(0, stderr.lastIndexOf('Summary:')));
  return {
    integratedLufs: firstNumber(
      summary,
      /Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/i,
    ),
    loudnessRangeLu: firstNumber(
      summary,
      /Loudness range:\s*\n\s*LRA:\s*(-?\d+(?:\.\d+)?)\s+LU/i,
    ),
    truePeakDbfs: firstNumber(
      summary,
      /True peak:\s*\n\s*Peak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/i,
    ),
  };
}

function parseAstats(stderr: string): Pick<
  AudioLevelSummary,
  'rmsDbfs' | 'crestFactor'
> & { zeroCrossingRate?: number } {
  return {
    rmsDbfs: firstNumber(stderr, /RMS level dB:\s*(-?\d+(?:\.\d+)?)/i),
    crestFactor: firstNumber(stderr, /Crest factor:\s*(-?\d+(?:\.\d+)?)/i),
    zeroCrossingRate: firstNumber(
      stderr,
      /Zero crossings rate:\s*(-?\d+(?:\.\d+)?)/i,
    ),
  };
}

function parseSilence(
  stderr: string,
  durationSeconds: number,
): Omit<
  AudioTimingSummary,
  'silenceThresholdDbfs' | 'minimumSilenceSeconds' | 'zeroCrossingRate'
> {
  const completed = [...stderr.matchAll(
    /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g,
  )];
  let silenceSeconds = completed.reduce((sum, match) => {
    return sum + (finiteNumber(match[2]) ?? 0);
  }, 0);
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)];
  if (starts.length > completed.length) {
    const lastStart = finiteNumber(starts.at(-1)?.[1]);
    if (lastStart !== undefined && durationSeconds > lastStart) {
      silenceSeconds += durationSeconds - lastStart;
    }
  }
  silenceSeconds = Math.min(durationSeconds, Math.max(0, silenceSeconds));
  return {
    silenceSeconds,
    silenceFraction: durationSeconds > 0 ? silenceSeconds / durationSeconds : 0,
    silenceIntervals: starts.length,
  };
}

function quantile(values: number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index];
}

function spectralValues(stdout: string, key: string): number[] {
  const pattern = new RegExp(`lavfi\\.aspectralstats\\.\\d+\\.${key}=([^\\s]+)`, 'g');
  return [...stdout.matchAll(pattern)]
    .map((match) => finiteNumber(match[1]))
    .filter((value): value is number => value !== undefined);
}

function parseSpectrum(stdout: string): AudioSpectrumSummary {
  const centroid = spectralValues(stdout, 'centroid');
  const rolloff = spectralValues(stdout, 'rolloff');
  const flatness = spectralValues(stdout, 'flatness');
  return {
    analysisSampleRateHz: SPECTRUM_SAMPLE_RATE_HZ,
    frames: Math.max(centroid.length, rolloff.length, flatness.length),
    centroidMedianHz: quantile(centroid, 0.5),
    centroidP10Hz: quantile(centroid, 0.1),
    centroidP90Hz: quantile(centroid, 0.9),
    rolloffMedianHz: quantile(rolloff, 0.5),
    flatnessMedian: quantile(flatness, 0.5),
  };
}

function fixed(value: number | undefined, digits: number): string | undefined {
  return value === undefined ? undefined : value.toFixed(digits);
}

function frequency(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${Math.round(value)} Hz`;
}

export function formatAudioAnalysisSummary(record: CachedAudioAnalysis): string {
  const formatBits = [
    record.format.container,
    record.format.codec,
    record.format.channelLayout
      || (record.format.channels ? `${record.format.channels} channel(s)` : undefined),
    record.format.sampleRateHz ? `${Math.round(record.format.sampleRateHz / 100) / 10} kHz` : undefined,
    record.format.bitrateKbps ? `${record.format.bitrateKbps.toFixed(1)} kb/s` : undefined,
  ].filter((value): value is string => Boolean(value));
  const levelBits = [
    fixed(record.level.integratedLufs, 1) && `${fixed(record.level.integratedLufs, 1)} LUFS integrated`,
    fixed(record.level.loudnessRangeLu, 1) && `${fixed(record.level.loudnessRangeLu, 1)} LU loudness range`,
    fixed(record.level.truePeakDbfs, 1) && `${fixed(record.level.truePeakDbfs, 1)} dBFS true peak`,
    fixed(record.level.rmsDbfs, 1) && `${fixed(record.level.rmsDbfs, 1)} dBFS RMS`,
    fixed(record.level.crestFactor, 2) && `${fixed(record.level.crestFactor, 2)} crest factor`,
  ].filter((value): value is string => Boolean(value));
  const centroid = frequency(record.spectrum.centroidMedianHz);
  const centroidLow = frequency(record.spectrum.centroidP10Hz);
  const centroidHigh = frequency(record.spectrum.centroidP90Hz);
  const spectrumBits = [
    centroid && `spectral centroid median ${centroid}` +
      (centroidLow && centroidHigh ? ` (p10–p90 ${centroidLow}–${centroidHigh})` : ''),
    frequency(record.spectrum.rolloffMedianHz)
      && `85% roll-off median ${frequency(record.spectrum.rolloffMedianHz)}`,
    fixed(record.spectrum.flatnessMedian, 3)
      && `spectral flatness median ${fixed(record.spectrum.flatnessMedian, 3)}`,
  ].filter((value): value is string => Boolean(value));

  return [
    `duration: ${record.format.durationSeconds.toFixed(2)} s` +
      (formatBits.length ? `; format: ${formatBits.join(', ')}` : ''),
    levelBits.length ? `level: ${levelBits.join('; ')}` : undefined,
    `timing: ${record.timing.silenceSeconds.toFixed(2)} s at or below ` +
      `${record.timing.silenceThresholdDbfs} dBFS for at least ` +
      `${record.timing.minimumSilenceSeconds.toFixed(2)} s ` +
      `(${(record.timing.silenceFraction * 100).toFixed(1)}%; ` +
      `${record.timing.silenceIntervals} interval(s))` +
      (record.timing.zeroCrossingRate === undefined
        ? ''
        : `; zero-crossing rate ${record.timing.zeroCrossingRate.toFixed(4)}`),
    spectrumBits.length
      ? `spectrum (${record.spectrum.analysisSampleRateHz / 1000} kHz mono analysis): ` +
        spectrumBits.join('; ')
      : undefined,
    'interpretation note: descriptive signal measurements only; no speaker, emotion, or intent inference',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function cachedResult(
  record: CachedAudioAnalysis,
  cacheDir: string,
  cached: boolean,
): AudioAnalysisResult {
  const spectrogramPath = join(cacheDir, record.spectrogramFile);
  return {
    summary: formatAudioAnalysisSummary(record),
    spectrogramData: readFileSync(spectrogramPath).toString('base64'),
    spectrogramMimeType: 'image/png',
    cached,
  };
}

/**
 * Build a visual and numeric sensory aid from a locally cached Discord audio
 * attachment. This is deliberately opt-in per MCPL process/residence: setting
 * DISCORD_AUDIO_ANALYSIS_ENABLED for Fable does not alter another resident's
 * attachment representation. Derived artifacts are cached by immutable
 * Discord attachment id so restarts never repeat the work.
 */
export async function analyzeDiscordAudio(
  attachmentId: string,
  audioPath: string,
  options: AudioAnalysisOptions = {},
): Promise<AudioAnalysisResult | null> {
  const config = configFor(audioPath);
  if (!config) return null;
  if (!existsSync(audioPath)) throw new Error('locally cached audio file is missing');
  if (statSync(audioPath).size > config.maxBytes) {
    throw new Error(`audio is over the ${config.maxBytes}-byte analysis cap`);
  }

  mkdirSync(config.cacheDir, { recursive: true });
  const stem = `${attachmentId}-analysis-v1`;
  const recordPath = join(config.cacheDir, `${stem}.json`);
  const spectrogramFile = `${stem}.spectrogram.png`;
  const spectrogramPath = join(config.cacheDir, spectrogramFile);
  const spectrogramTempPath = join(
    config.cacheDir,
    `${stem}.${process.pid}.tmp.png`,
  );
  const lockPath = join(config.cacheDir, `${stem}.lock`);
  const deadline = Date.now() + config.timeoutMs * 6;

  let ownsLock = false;
  while (!ownsLock) {
    const cached = readCached(recordPath, config.cacheDir, attachmentId);
    if (cached) return cachedResult(cached, config.cacheDir, true);
    ownsLock = acquireLock(lockPath);
    if (ownsLock) break;
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for the shared audio-analysis cache');
    }
    await delay(200);
  }

  try {
    const cached = readCached(recordPath, config.cacheDir, attachmentId);
    if (cached) return cachedResult(cached, config.cacheDir, true);

    const run = options.runCommand ?? defaultCommandRunner;
    const commandOptions = {
      timeoutMs: config.timeoutMs,
      maxBuffer: COMMAND_MAX_BUFFER,
    };
    const probe = await run(config.ffprobePath, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries',
      'stream=codec_name,codec_type,sample_rate,channels,channel_layout:' +
        'format=duration,bit_rate,format_name',
      '-of', 'json',
      audioPath,
    ], commandOptions);
    const format = parseProbe(probe.stdout);

    const ebur = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', audioPath,
      '-map', '0:a:0',
      '-af', 'ebur128=peak=true:framelog=quiet',
      '-f', 'null', '-',
    ], commandOptions);
    const astats = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', audioPath,
      '-map', '0:a:0',
      '-af',
      'aformat=channel_layouts=mono,' +
        'astats=metadata=0:reset=0:' +
        'measure_perchannel=RMS_level+Crest_factor+Zero_crossings_rate:' +
        'measure_overall=none',
      '-f', 'null', '-',
    ], commandOptions);
    const silence = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', audioPath,
      '-map', '0:a:0',
      '-af',
      `aformat=channel_layouts=mono,silencedetect=n=${SILENCE_THRESHOLD_DBFS}dB:` +
        `d=${MINIMUM_SILENCE_SECONDS}`,
      '-f', 'null', '-',
    ], commandOptions);
    const spectrum = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-loglevel', 'error', '-i', audioPath,
      '-map', '0:a:0',
      '-af',
      `aformat=channel_layouts=mono,aresample=${SPECTRUM_SAMPLE_RATE_HZ},` +
        'aspectralstats=win_size=8192:overlap=0:' +
        'measure=centroid+flatness+rolloff,ametadata=print:file=-',
      '-f', 'null', '-',
    ], commandOptions);

    const sampleRateHz = format.sampleRateHz ?? 48_000;
    const stopFrequencyHz = Math.max(40, Math.floor(sampleRateHz / 2));
    const spectrogramFilter =
      `[0:a:0]showspectrumpic=s=1200x640:legend=1:scale=log:fscale=log:` +
      `color=magma:drange=100:start=20:stop=${stopFrequencyHz}[v]`;
    try {
      await run(config.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', audioPath,
        '-filter_complex', spectrogramFilter,
        '-map', '[v]', '-frames:v', '1', spectrogramTempPath,
      ], commandOptions);
      if (!isPng(spectrogramTempPath)) {
        throw new Error('ffmpeg did not produce a valid PNG spectrogram');
      }
      renameSync(spectrogramTempPath, spectrogramPath);
    } finally {
      try { unlinkSync(spectrogramTempPath); } catch { /* absent after rename */ }
    }

    const astatsSummary = parseAstats(astats.stderr);
    const silenceSummary = parseSilence(silence.stderr, format.durationSeconds);
    const record: CachedAudioAnalysis = {
      schema: 'discord-audio-analysis/v1',
      attachmentId,
      analyzedAt: (options.now ?? (() => new Date()))().toISOString(),
      analyzer: 'ffmpeg',
      sourceAudioFile: basename(audioPath),
      spectrogramFile,
      format,
      level: {
        ...parseEbur128(ebur.stderr),
        rmsDbfs: astatsSummary.rmsDbfs,
        crestFactor: astatsSummary.crestFactor,
      },
      timing: {
        silenceThresholdDbfs: SILENCE_THRESHOLD_DBFS,
        minimumSilenceSeconds: MINIMUM_SILENCE_SECONDS,
        ...silenceSummary,
        zeroCrossingRate: astatsSummary.zeroCrossingRate,
      },
      spectrum: parseSpectrum(spectrum.stdout),
    };
    atomicWrite(recordPath, JSON.stringify(record, null, 2) + '\n');
    return cachedResult(record, config.cacheDir, false);
  } finally {
    try { unlinkSync(lockPath); } catch { /* already released or cleaned up */ }
  }
}
