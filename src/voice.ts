/**
 * Voice output: speaks the host's streamed prose (MCPL `channels/outgoing/*`,
 * Spec 14.3) into a Discord voice channel under this agent's own bot.
 *
 * The hard problems live elsewhere by design: the HOST routes prose per line
 * (fail-closed) and only streams chunks whose destination is settled, so by
 * the time a delta reaches us it is speech, for a known channel, in order.
 * This module: filters to the voiced text channel(s), feeds deltas into a
 * streaming TTS provider (@animalabs/voice-kit — pluggable), and plays the
 * audio as it synthesizes. Latency = provider time-to-first-audio (~0.7 s),
 * overlapping generation instead of following it.
 *
 * PHYSICS LAYER (floor-control.md §1.1) — audio is a destructive-interference
 * medium; these rules run regardless of any social protocol above them:
 *
 *  - CARRIER-SENSE: never begin emitting while anyone else in the channel is
 *    speaking. On silence, wait a random hold-off (150–500 ms), re-check,
 *    then emit. Implemented via the connection receiver's speaking events
 *    (events only — we stay deaf to CONTENT; STT is portal-relay's job).
 *  - ZERO-COST-LOSER (convergence review, Sol 8/5): carrier-clear before
 *    synthesis. The provider SOCKET pre-opens at first delta (free — only
 *    characters bill), but text banks locally and flushes into synthesis
 *    only on the sink's 'cleared' event. An utterance dropped while queued
 *    (interruption of the queue via stop(), or maxHoldMs expiry) bills zero
 *    characters and never re-runs inference: the banked text simply waits,
 *    and on expiry the model gets an 'expired' receipt and decides for
 *    itself whether re-saying is worth a turn.
 *  - HUMAN BARGE-IN: a human speaking mid-utterance aborts playback AND
 *    upstream synthesis immediately. Humans are above the protocol (I1).
 *    Unknown speakers are treated as human — physics yields when unsure.
 *  - BOT COLLISION: two bots starting near-simultaneously (within the
 *    collision window) resolve deterministically — higher snowflake yields.
 *    A bot that starts speaking AFTER our window is ignored: its own
 *    carrier-sense should have held it, and physics must not reward barging.
 *  - INTERRUPTION ACCOUNTING: the model must know what was and was not
 *    heard. Per utterance we track sent text + provider char alignment +
 *    played-audio ms, and report the voiced/unvoiced split upward
 *    (server.ts pushes it to the host as an event). Without alignment the
 *    split is estimated from audio duration and flagged `estimated`.
 *
 * Spec discipline: `channels/outgoing/*` is ADVISORY — the authoritative
 * delivery is `channels/publish`. This module must never post text.
 *
 * Testability: the TTS provider and the audio sink are injected; CarrierGate
 * is pure; Discord specifics live in DiscordVoiceSink below (dynamic imports
 * keep @discordjs/voice out of the graph unless voice is configured).
 */
import { PassThrough, type Readable } from 'node:stream';
import {
  EnergyVad,
  monoTo48kStereo,
  loadRegistry,
  resolveVoice,
  type TtsAlignment,
  type TtsProvider,
  type TtsStream,
  type TtsVoice,
} from '@animalabs/voice-kit';
import { parseMcplChannelId } from './channels.js';
import { VAD_THRESHOLD_DB, type VoiceEnv } from './voice-env.js';

// Physics constants (floor-control.md: seed-tunable within safe bounds).
const HOLDOFF_MIN_MS = 150;
const HOLDOFF_MAX_MS = 500;
const COLLISION_WINDOW_MS = 250;
/** Human speech must be SUSTAINED this long before it counts as barge-in.
 *  A single packet burst is not speech: Discord clients emit ~100 ms blips
 *  on unmute (mic pop) and on VAD false-triggers (keyboard, cough), and
 *  live-testing showed an unmute alone killing an utterance before the
 *  human said a word. Asymmetric with carrier-sense on purpose: for
 *  STARTING to speak, a false carrier only costs politeness (we wait a
 *  beat longer); for ABORTING mid-utterance, a false trigger costs the
 *  whole utterance. Total worst-case yield latency stays conversational:
 *  debounce + player stop ≈ half a second. */
const BARGE_IN_SUSTAIN_MS = 250;
/** Played-vs-synthesized slack under which a completed utterance counts as
 *  fully voiced (avoids alignment-jitter noise in the common happy path). */
const FULLY_PLAYED_SLACK_MS = 250;
/** Provider sockets pre-opened at once. Sockets are billing-free but not
 *  limit-free (providers cap concurrent connections); a deep queue would
 *  hold one idle socket per waiting utterance. Deeper items open at
 *  clearance instead — their connection latency hides inside a queue wait
 *  that is already long (#28 review, nonblocking 1). */
const PRE_OPEN_MAX = 3;

export interface VoiceOutputConfig {
  /** Raw text-channel snowflakes whose streamed prose is voiced. Null = all. */
  textChannels: string[] | null;
  /** Longest an utterance may wait for the floor before it is dropped
   *  UNSPOKEN with an 'expired' receipt (the model then decides whether
   *  re-saying is worth an inference — the transport never re-runs one).
   *  Null/absent = wait indefinitely; words are patient and cost nothing
   *  while queued. */
  maxHoldMs?: number | null;
}

// ── Speakers, sink contract ─────────────────────────────────────────────────

export interface SpeakerInfo {
  userId: string;
  username?: string;
  /** false for humans AND unknowns — physics yields when unsure. */
  bot: boolean;
}

export interface SinkItem {
  /** Utterance id (= inferenceId); ties sink events back to accounting. */
  id: string;
  /** 48k stereo raw PCM. */
  stream: Readable;
}

export type SinkEvent =
  /** The item passed carrier-clear + hold-off and is about to play. THE
   *  BILLING GATE: VoiceOutput flushes buffered text to the TTS provider on
   *  this event and not before (zero-cost-loser — an utterance that never
   *  clears never bills a character). */
  | { type: 'cleared'; id: string }
  | { type: 'started'; id: string }
  | { type: 'finished'; id: string; playedMs: number }
  | { type: 'interrupted'; id: string; playedMs: number; by: SpeakerInfo };

/** Audio sink: queues utterances, plays them one at a time under the physics
 *  rules, reports what actually happened to each. */
export interface PcmSink {
  play(item: SinkItem): void;
  /** Drop a STILL-QUEUED item (max-hold expiry). Returns false when the item
   *  is unknown or already cleared/playing — the caller treats that as
   *  losing the race and does nothing. Never touches the current item. */
  cancel(id: string): boolean;
  onEvent(fn: (ev: SinkEvent) => void): void;
}

// ── Carrier gate (pure; the sink feeds it speaking events) ─────────────────

/**
 * Tracks who is currently speaking and gates emission on silence + hold-off.
 * No Discord types — the sink adapts receiver speaking events into
 * speakingStart/speakingEnd calls; tests drive it directly.
 */
export class CarrierGate {
  private speakers = new Map<string, SpeakerInfo>();
  private changeFns: Array<() => void> = [];
  private startFns: Array<(s: SpeakerInfo) => void> = [];
  private sustainedFns: Array<{ ms: number; fn: (s: SpeakerInfo) => void }> = [];

  speakingStart(s: SpeakerInfo): void {
    this.speakers.set(s.userId, s);
    for (const fn of this.startFns) { try { fn(s); } catch { /* consumer's */ } }
    for (const { ms, fn } of this.sustainedFns) {
      setTimeout(() => {
        // Still on the carrier after the debounce window → real speech.
        // (A blip that ended and re-triggered counts: rapid re-trigger IS
        // sustained speech as far as the medium can tell.)
        if (this.speakers.has(s.userId)) { try { fn(s); } catch { /* consumer's */ } }
      }, ms).unref?.();
    }
    this.emitChange();
  }

  speakingEnd(userId: string): void {
    if (this.speakers.delete(userId)) this.emitChange();
  }

  busy(): boolean { return this.speakers.size > 0; }

  isSpeaking(userId: string): boolean { return this.speakers.has(userId); }

  /** Fires on every speaking START — including one-packet blips (unmute
   *  pops, VAD false-triggers). Use for collision decisions and logging,
   *  NOT for barge-in. */
  onSpeakerStart(fn: (s: SpeakerInfo) => void): void { this.startFns.push(fn); }

  /** Fires when a speaker has held the carrier for `ms` continuously-ish
   *  (still present when the debounce timer lands). This is the barge-in
   *  signal: blips never fire it. */
  onSpeakerSustained(ms: number, fn: (s: SpeakerInfo) => void): void {
    this.sustainedFns.push({ ms, fn });
  }

  /**
   * Resolves once the channel has been silent for a full random hold-off
   * (CSMA/CA): silence → draw hold-off → if anyone speaks during it, go back
   * to waiting for silence and redraw. The randomness is the collision
   * avoidance — two gated bots releasing into the same silence draw
   * different hold-offs and the later one re-holds on the earlier's carrier.
   */
  async waitClear(minHoldMs = HOLDOFF_MIN_MS, maxHoldMs = HOLDOFF_MAX_MS): Promise<void> {
    for (;;) {
      while (this.busy()) await this.nextChange();
      const holdMs = minHoldMs + Math.random() * (maxHoldMs - minHoldMs);
      if (await this.quietFor(holdMs)) return;
    }
  }

  /** True if the channel stayed silent for the whole window. */
  private quietFor(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onChange = () => {
        if (!this.busy()) return; // an END during the window doesn't reset it
        clearTimeout(timer);
        this.changeFns = this.changeFns.filter((f) => f !== onChange);
        resolve(false);
      };
      timer = setTimeout(() => {
        this.changeFns = this.changeFns.filter((f) => f !== onChange);
        resolve(true);
      }, ms);
      this.changeFns.push(onChange);
    });
  }

  private nextChange(): Promise<void> {
    return new Promise((resolve) => {
      const fn = () => {
        this.changeFns = this.changeFns.filter((f) => f !== fn);
        resolve();
      };
      this.changeFns.push(fn);
    });
  }

  private emitChange(): void {
    for (const fn of [...this.changeFns]) { try { fn(); } catch { /* internal */ } }
  }
}

// ── Utterance accounting ────────────────────────────────────────────────────

export interface UtteranceReport {
  inferenceId: string;
  /** MCPL channel id the prose was streaming to. */
  channelId: string;
  /** 'expired' = dropped unspoken after maxHoldMs in the queue: nothing was
   *  billed, nothing was heard, and the model decides whether to re-say. */
  status: 'spoken' | 'interrupted' | 'expired';
  /** Audio actually played into the channel, ms. */
  playedMs: number;
  /** Time spent queued behind the carrier before clearance (or before
   *  expiry, for status 'expired'). Staleness signal for the model. */
  queuedMs: number;
  /** Characters actually sent to the TTS provider — the zero-cost-loser
   *  receipt: 0 for anything dropped before clearance. */
  billedChars: number;
  /** The prefix of the sent text that was actually heard. */
  voicedText: string;
  /** The remainder that was NOT heard (interruption, TTS truncation). */
  unvoicedText: string;
  /** True when the split was estimated from audio duration (no char
   *  alignment from the provider) — boundary is approximate. */
  estimated: boolean;
  /** Who cut us off (status 'interrupted' only). */
  interruptedBy?: SpeakerInfo;
}

interface ActiveUtterance {
  /** Live provider stream. Pre-opened at first delta (a socket is free; only
   *  characters bill) so clearance pays synthesis latency, not connection
   *  latency. Null when pre-open failed; replaced if it dies while queued. */
  tts: TtsStream | null;
  /** The pre-opened stream died (idle timeout, error) before clearance —
   *  flush must open a fresh one. */
  ttsDead: boolean;
  out: PassThrough;
  channelId: string;
  /** All prose received from the host for this inference. */
  sentText: string;
  /** Received but not yet billed: accumulates until clearance, then flushes
   *  to the provider in one send. Empty once cleared. */
  pendingText: string;
  /** Characters actually sent to the provider (the billing receipt). */
  billedChars: number;
  /** Sink reported carrier-clear; deltas now stream to the provider live. */
  cleared: boolean;
  queuedAt: number;
  clearedAt: number | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** Flattened provider alignment, stream-absolute ms (voice-kit contract). */
  aChars: string[];
  aStartMs: number[];
  aDurMs: number[];
  /** Total synthesized audio received from the provider, ms. */
  audioMs: number;
  /** Host sent channels/outgoing/complete. */
  done: boolean;
}

export class VoiceOutput {
  private active = new Map<string, ActiveUtterance>(); // inferenceId →
  private skipped = new Set<string>();                 // inferenceIds we're ignoring
  private reportFns: Array<(r: UtteranceReport) => void> = [];

  constructor(
    private cfg: VoiceOutputConfig,
    private tts: TtsProvider,
    private voice: TtsVoice,
    private sink: PcmSink,
    private log: (m: string) => void = (m) => console.error(`[discord-mcpl voice] ${m}`),
  ) {
    this.sink.onEvent((ev) => this.handleSinkEvent(ev));
  }

  /** Utterance outcomes — server.ts forwards the ones the model must know
   *  about (anything unvoiced) to the host as push events. */
  onReport(fn: (r: UtteranceReport) => void): void { this.reportFns.push(fn); }

  handleChunk(inferenceId: string, mcplChannelId: string, delta: string): void {
    if (this.skipped.has(inferenceId)) return;
    let utt = this.active.get(inferenceId);
    if (!utt) {
      const parsed = parseMcplChannelId(mcplChannelId);
      if (!parsed || (this.cfg.textChannels && !this.cfg.textChannels.includes(parsed.channelId))) {
        this.skipped.add(inferenceId);
        return;
      }
      const opened = this.open(inferenceId, mcplChannelId);
      if (!opened) { this.skipped.add(inferenceId); return; }
      utt = opened;
    }
    if (utt.done) return; // chunks after complete: host bug, drop
    utt.sentText += delta;
    // BILLING GATE (zero-cost-loser): before clearance, text banks locally —
    // the inference already ran, the words wait for free. Only a cleared
    // utterance streams characters to the provider.
    if (utt.cleared && utt.tts && !utt.ttsDead) {
      utt.tts.sendText(delta);
      utt.billedChars += delta.length;
    } else {
      utt.pendingText += delta;
    }
  }

  handleComplete(inferenceId: string): void {
    this.skipped.delete(inferenceId);
    const utt = this.active.get(inferenceId);
    if (!utt || utt.done) return;
    utt.done = true;
    // Cleared → end the provider stream; audio keeps draining into the
    // queued stream and onEnd closes it. Still queued → nothing to end yet:
    // handleCleared ends the stream after the flush.
    if (utt.cleared && utt.tts && !utt.ttsDead) utt.tts.end();
    // The active entry survives until the sink reports what happened —
    // accounting needs sentText/alignment at finished/interrupted time.
  }

  stop(): void {
    for (const [, utt] of this.active) {
      if (utt.holdTimer) clearTimeout(utt.holdTimer);
      utt.tts?.abort();
      utt.out.end();
    }
    this.active.clear();
    this.skipped.clear();
  }

  private open(inferenceId: string, channelId: string): ActiveUtterance | null {
    const out = new PassThrough();
    const utt: ActiveUtterance = {
      tts: null, ttsDead: false, out, channelId,
      sentText: '', pendingText: '', billedChars: 0,
      cleared: false, queuedAt: Date.now(), clearedAt: null, holdTimer: null,
      aChars: [], aStartMs: [], aDurMs: [], audioMs: 0, done: false,
    };
    // Pre-open the provider socket (free — only characters bill) so that at
    // clearance we pay synthesis latency, not connection latency. Capped:
    // past PRE_OPEN_MAX concurrent utterances the socket opens at clearance
    // via the same path that revives a dead one. Failure is not fatal here:
    // handleCleared retries once before going text-only.
    if (this.active.size < PRE_OPEN_MAX) this.openProviderStream(utt);
    // Queue for playback immediately. The sink's 'cleared' event — after
    // carrier-clear + hold-off, right before play — is what flushes banked
    // text into synthesis.
    this.sink.play({ id: inferenceId, stream: out });
    const maxHold = this.cfg.maxHoldMs;
    if (maxHold != null && maxHold > 0) {
      utt.holdTimer = setTimeout(() => this.expire(inferenceId), maxHold);
      utt.holdTimer.unref?.();
    }
    this.active.set(inferenceId, utt);
    return utt;
  }

  /** Open (or replace) the provider stream for an utterance and wire its
   *  events. Callbacks guard on stream identity so a replaced stream's late
   *  events can't touch the utterance. */
  private openProviderStream(utt: ActiveUtterance): boolean {
    let tts: TtsStream;
    try {
      tts = this.tts.openStream(this.voice);
    } catch (err) {
      this.log(`TTS open failed: ${(err as Error).message}`);
      utt.tts = null;
      utt.ttsDead = true;
      return false;
    }
    utt.tts = tts;
    utt.ttsDead = false;
    const rate = this.tts.outputRateHz;
    tts.onAlignment((a: TtsAlignment) => {
      if (utt.tts !== tts) return;
      utt.aChars.push(...a.chars);
      utt.aStartMs.push(...a.startMs);
      utt.aDurMs.push(...a.durationMs);
    });
    tts.onAudio((pcm) => {
      if (utt.tts !== tts) return;
      utt.audioMs += pcm.length / 2 / (rate / 1000); // PCM16 mono
      utt.out.write(monoTo48kStereo(pcm, rate));
    });
    tts.onEnd(() => {
      if (utt.tts !== tts) return;
      // Post-clearance this is normal completion. Pre-clearance nothing was
      // ever sent, so an end is the provider hanging up (idle timeout) —
      // mark dead; handleCleared reopens.
      if (utt.cleared) utt.out.end();
      else utt.ttsDead = true;
    });
    tts.onError((e) => {
      if (utt.tts !== tts) return;
      if (utt.cleared) {
        this.log(`TTS stream error: ${e.message}`);
        utt.out.end();
      } else {
        // Queued utterances survive a dying socket: reopen at clearance.
        this.log(`TTS stream error while queued (will reopen at clearance): ${e.message}`);
        utt.ttsDead = true;
      }
    });
    return true;
  }

  /** The sink cleared this utterance to play: flush banked text into
   *  synthesis (opening a fresh stream if the pre-opened one died). This is
   *  the only place characters start billing. */
  private handleCleared(inferenceId: string): void {
    const utt = this.active.get(inferenceId);
    if (!utt || utt.cleared) return;
    utt.cleared = true;
    utt.clearedAt = Date.now();
    if (utt.holdTimer) { clearTimeout(utt.holdTimer); utt.holdTimer = null; }
    if ((!utt.tts || utt.ttsDead) && !this.openProviderStream(utt)) {
      // No provider stream and the reopen failed: the line stays text-only.
      // Ending the (empty) audio stream lets the sink finish it at 0 ms and
      // the report goes up as a truncation with billedChars 0.
      this.log('TTS unavailable at clearance — line stays text-only');
      utt.out.end();
      return;
    }
    if (utt.pendingText.length > 0) {
      utt.tts!.sendText(utt.pendingText);
      utt.billedChars += utt.pendingText.length;
      utt.pendingText = '';
    }
    if (utt.done) utt.tts!.end();
  }

  /** Max-hold expiry: the floor never opened. Drop the utterance UNSPOKEN
   *  with a receipt — zero characters billed, the model decides whether
   *  re-saying is worth an inference. */
  private expire(inferenceId: string): void {
    const utt = this.active.get(inferenceId);
    if (!utt || utt.cleared) return; // cleared won the race
    if (!this.sink.cancel(inferenceId)) return; // dequeuing raced us; let it play
    this.active.delete(inferenceId);
    if (!utt.done) this.skipped.add(inferenceId); // drop trailing chunks
    utt.tts?.abort();
    utt.out.end();
    this.report({
      inferenceId, channelId: utt.channelId, status: 'expired',
      playedMs: 0, queuedMs: Date.now() - utt.queuedAt, billedChars: utt.billedChars,
      voicedText: '', unvoicedText: utt.sentText, estimated: false,
    });
  }

  private handleSinkEvent(ev: SinkEvent): void {
    if (ev.type === 'cleared') { this.handleCleared(ev.id); return; }
    if (ev.type === 'started') return;
    const utt = this.active.get(ev.id);
    if (!utt) return;
    this.active.delete(ev.id);
    if (utt.holdTimer) { clearTimeout(utt.holdTimer); utt.holdTimer = null; }
    const queuedMs = Math.max(0, (utt.clearedAt ?? utt.queuedAt) - utt.queuedAt);

    if (ev.type === 'interrupted') {
      // Kill synthesis and drop any not-yet-arrived prose for this inference:
      // the utterance is dead, resuming mid-thought as audio would be worse
      // than the model re-deciding what (and whether) to say.
      utt.tts?.abort();
      utt.out.end();
      if (!utt.done) this.skipped.add(ev.id);
      const split = this.split(utt, ev.playedMs);
      this.report({
        inferenceId: ev.id, channelId: utt.channelId, status: 'interrupted',
        playedMs: ev.playedMs, queuedMs, billedChars: utt.billedChars,
        ...split, interruptedBy: ev.by,
      });
      return;
    }

    // 'finished' — natural end, or truncation (TTS error ended the stream
    // early). Fully-played completed utterances snap to the full text so
    // alignment jitter can't manufacture phantom unvoiced tails.
    const fullyPlayed = utt.done && ev.playedMs + FULLY_PLAYED_SLACK_MS >= utt.audioMs;
    const split = fullyPlayed
      ? { voicedText: utt.sentText, unvoicedText: '', estimated: false }
      : this.split(utt, ev.playedMs);
    this.report({
      inferenceId: ev.id, channelId: utt.channelId, status: 'spoken',
      playedMs: ev.playedMs, queuedMs, billedChars: utt.billedChars,
      ...split,
    });
  }

  /** Voiced/unvoiced split at a playback position. Alignment chars map onto
   *  the input text (voice-kit contract), so counting played chars and
   *  slicing sentText by that count is exact; text the provider never
   *  synthesized (alignment shorter than sentText) is unvoiced by
   *  construction. */
  private split(utt: ActiveUtterance, playedMs: number):
    { voicedText: string; unvoicedText: string; estimated: boolean } {
    if (utt.aChars.length > 0) {
      let n = 0;
      for (let i = 0; i < utt.aChars.length; i++) {
        // A char counts as heard once its midpoint has played.
        if (utt.aStartMs[i]! + utt.aDurMs[i]! / 2 <= playedMs) n++;
      }
      n = Math.min(n, utt.sentText.length);
      return { voicedText: utt.sentText.slice(0, n), unvoicedText: utt.sentText.slice(n), estimated: false };
    }
    if (utt.audioMs > 0) {
      const frac = Math.max(0, Math.min(1, playedMs / utt.audioMs));
      const n = Math.round(utt.sentText.length * frac);
      return { voicedText: utt.sentText.slice(0, n), unvoicedText: utt.sentText.slice(n), estimated: true };
    }
    return { voicedText: '', unvoicedText: utt.sentText, estimated: true };
  }

  private report(r: UtteranceReport): void {
    for (const fn of this.reportFns) { try { fn(r); } catch { /* consumer's */ } }
  }
}

// ── Discord sink + env wiring ────────────────────────────────────────────────

/** Build a VoiceOutput from env + a discord.js client. Throws on bad registry
 *  or missing voice; caller treats voice as optional and logs. */
export async function createVoiceOutput(env: VoiceEnv, client: unknown): Promise<VoiceOutput> {
  const registry = loadRegistry(env.registryPath);
  const voice = resolveVoice(registry, env.voiceName);
  if (!voice) throw new Error(`no registry voice for "${env.voiceName}" (and no defaultBotVoice)`);
  const { ElevenLabsTtsProvider } = await import('@animalabs/voice-kit');
  const provider = new ElevenLabsTtsProvider(env.elevenKey);
  const sink = new DiscordVoiceSink(env.vadThresholdDb);
  await sink.connect(client, env.guildId, env.voiceChannelId);
  return new VoiceOutput({ textChannels: env.textChannels, maxHoldMs: env.maxHoldMs }, provider, voice, sink);
}

/** Plays 48k stereo raw PCM utterances sequentially in a Discord voice
 *  channel, under the physics rules (carrier-sense, human barge-in, bot
 *  collision yield), and reports each utterance's fate. */
export class DiscordVoiceSink implements PcmSink {
  private player: import('@discordjs/voice').AudioPlayer | null = null;
  private queue: SinkItem[] = [];
  private playing = false;
  private eventFns: Array<(ev: SinkEvent) => void> = [];
  private levelFns: Array<(userId: string, db: number) => void> = [];
  private speakerAudioFns: Array<(speaker: SpeakerInfo, pcm: Buffer) => void> = [];
  private selfId = '';
  private current: {
    id: string;
    resource: import('@discordjs/voice').AudioResource;
    startedAt: number;
    interruptedBy: SpeakerInfo | null;
  } | null = null;
  /** Per-speaker VAD pipelines (userId → cleanup). */
  private pipelines = new Map<string, () => void>();
  /** Speakers on packet-presence semantics (their pipeline failed). */
  private packetFallback = new Set<string>();
  /** null until connect(); false = opus decode unavailable → packet mode. */
  private vadMode = true;

  readonly gate = new CarrierGate();

  constructor(private vadThresholdDb: number = VAD_THRESHOLD_DB) {}

  /** Per-frame speaker levels (dBFS) — live threshold calibration. */
  onLevel(fn: (userId: string, db: number) => void): void { this.levelFns.push(fn); }

  /** Decoded per-speaker audio (48k stereo PCM16), as it flows. This is the
   *  tap for STT consumers (voice-chat harness, a future channel listener):
   *  the sink already decodes for the energy VAD, so hearing-as-listening
   *  costs nothing extra here. Only fires in VAD mode. */
  onSpeakerAudio(fn: (speaker: SpeakerInfo, pcm: Buffer) => void): void { this.speakerAudioFns.push(fn); }

  async connect(client: unknown, guildId: string, channelId: string): Promise<void> {
    const { joinVoiceChannel, createAudioPlayer, entersState, NoSubscriberBehavior, VoiceConnectionStatus, EndBehaviorType } =
      await import('@discordjs/voice');
    // prism-media rides in with @discordjs/voice; opus decode runs on
    // opusscript (already a dep). If either is missing we fall back to
    // packet-presence carrier sensing (worse with hot mics, never fatal).
    let prism: typeof import('prism-media') | null = null;
    try { prism = (await import('prism-media')).default ?? await import('prism-media'); }
    catch { this.vadMode = false; }

    const c = client as import('discord.js').Client;
    const guild = await c.guilds.fetch(guildId);
    this.selfId = c.user?.id ?? '';
    const conn = joinVoiceChannel({
      channelId, guildId,
      adapterCreator: guild.voiceAdapterCreator,
      // NOT deafened: the carrier gate needs to hear the MEDIUM. In VAD
      // mode we decode each speaker's audio just far enough to measure
      // loudness — RMS per 20 ms frame, discarded immediately. No STT, no
      // content, nothing stored or forwarded: meaning-deaf, not
      // energy-deaf. (Hearing-as-listening is portal-relay's job.)
      // Consequence: the Discord UI shows this bot as listening
      // (undeafened) — which is honest, it does receive audio; anyone
      // auditing what it retains should be pointed at this comment.
      selfDeaf: false,
    });
    await entersState(conn, VoiceConnectionStatus.Ready, 15_000);

    conn.receiver.speaking.on('start', (userId: string) => {
      if (userId === this.selfId) return; // our own emissions aren't a carrier
      const u = c.users.cache.get(userId);
      // Unknown user → treat as human: physics yields when unsure.
      const info: SpeakerInfo = { userId, username: u?.username, bot: u?.bot ?? false };
      if (!this.vadMode || !prism) { this.gate.speakingStart(info); return; }
      this.ensurePipeline(conn.receiver, prism, EndBehaviorType, info);
    });
    conn.receiver.speaking.on('end', (userId: string) => {
      // VAD mode: the subscription's AfterSilence end handles teardown; the
      // gate is driven by energy transitions, not packet presence. Speakers
      // on per-speaker packet fallback (pipeline construction failed) are
      // released here too.
      if (!this.vadMode || this.packetFallback.delete(userId)) this.gate.speakingEnd(userId);
    });
    // Bot collision: immediate (synthesized streams don't blip — a bot's
    // first voiced frame is real audio). Human barge-in: in VAD mode it is
    // wired per-pipeline on ≥250 ms of cumulative VOICED audio (see
    // ensurePipeline) — NOT on gate presence, which the VAD hangover keeps
    // alive past any presence-based debounce (live finding: an unmute
    // transient opened speech, hangover carried it through the 250 ms
    // presence check, utterance died to a spike). Packet-fallback speakers
    // (no VAD) get the presence-based debounce as a lesser evil.
    this.gate.onSpeakerStart((s) => { if (s.bot) this.maybeYield(s); });
    this.gate.onSpeakerSustained(BARGE_IN_SUSTAIN_MS, (s) => {
      if (!s.bot && (this.packetFallback.has(s.userId) || !this.vadMode)) this.maybeYield(s);
    });

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    conn.subscribe(this.player);
    console.error(
      `[discord-mcpl voice] joined voice channel ${channelId} ` +
      `(carrier-sense on, ${this.vadMode ? `energy VAD @ ${this.vadThresholdDb} dBFS` : 'packet mode — opus decode unavailable'})`,
    );
  }

  /** One decode→VAD pipeline per actively-transmitting speaker. The gate
   *  only learns about speakers whose audio crosses the energy threshold —
   *  a hot mic at the noise floor never busies the channel. */
  private ensurePipeline(
    receiver: import('@discordjs/voice').VoiceReceiver,
    prism: typeof import('prism-media'),
    EndBehaviorType: typeof import('@discordjs/voice').EndBehaviorType,
    info: SpeakerInfo,
  ): void {
    if (this.pipelines.has(info.userId)) return;
    try {
      const opus = receiver.subscribe(info.userId, {
        // Keep the stream alive across short pauses; the VAD's hangover is
        // the semantic boundary, this is just transport lifecycle.
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const vad = new EnergyVad({ rateHz: 48000, channels: 2, thresholdDb: this.vadThresholdDb });
      vad.onSpeechStart(() => this.gate.speakingStart(info));
      vad.onSpeechEnd(() => this.gate.speakingEnd(info.userId));
      // Barge-in qualifier: cumulative voiced audio, hangover excluded.
      if (!info.bot) vad.onSpeechSustained(BARGE_IN_SUSTAIN_MS, () => this.maybeYield(info));
      vad.onLevel((db) => { for (const fn of this.levelFns) { try { fn(info.userId, db); } catch { /* consumer's */ } } });
      const cleanup = () => {
        this.pipelines.delete(info.userId);
        vad.end(); // emits speechEnd → gate, if speech was open
        decoder.destroy();
      };
      opus.once('end', cleanup);
      opus.once('error', cleanup);
      decoder.on('error', (e: Error) => {
        console.error(`[discord-mcpl voice] opus decode error (${info.username ?? info.userId}): ${e.message}`);
        cleanup();
      });
      opus.pipe(decoder).on('data', (pcm: Buffer) => {
        vad.feed(pcm);
        for (const fn of this.speakerAudioFns) { try { fn(info, pcm); } catch { /* consumer's */ } }
      });
      this.pipelines.set(info.userId, cleanup);
    } catch (err) {
      // Pipeline construction failed → be conservative for THIS speaker:
      // packet-presence semantics (carrier now, released by the global
      // speaking-end handler via packetFallback membership).
      console.error(`[discord-mcpl voice] VAD pipeline failed (${info.userId}): ${(err as Error).message} — packet fallback`);
      this.packetFallback.add(info.userId);
      this.gate.speakingStart(info);
    }
  }

  play(item: SinkItem): void {
    this.queue.push(item);
    void this.pump();
  }

  cancel(id: string): boolean {
    const i = this.queue.findIndex((item) => item.id === id);
    if (i < 0) return false; // unknown, or already dequeued for play
    this.queue.splice(i, 1);
    return true;
  }

  onEvent(fn: (ev: SinkEvent) => void): void { this.eventFns.push(fn); }

  /** Physics: humans always win; bots yield deterministically inside the
   *  collision window (higher snowflake backs off — arbitrary but symmetric
   *  and stable). A bot starting AFTER the window is the one violating
   *  carrier-sense; yielding to it would reward barging, so we don't. */
  private maybeYield(s: SpeakerInfo): void {
    const cur = this.current;
    if (!cur || cur.interruptedBy) return;
    const human = !s.bot;
    const collision = s.bot &&
      Date.now() - cur.startedAt <= COLLISION_WINDOW_MS &&
      compareSnowflakes(this.selfId, s.userId) > 0;
    if (!human && !collision) return;
    cur.interruptedBy = s;
    this.player?.stop(true); // → Idle; pump() emits 'interrupted' with playedMs
  }

  private async pump(): Promise<void> {
    if (this.playing || !this.player) return;
    this.playing = true;
    try {
      const { createAudioResource, StreamType, AudioPlayerStatus, entersState } = await import('@discordjs/voice');
      while (this.queue.length) {
        // Carrier-sense: emit only into hold-off-verified silence.
        await this.gate.waitClear();
        // The queue can empty DURING the wait (max-hold expiry cancelling
        // every queued item while a human talks past the hold) — an
        // unguarded shift here was an unhandled rejection that took the
        // whole child down (#28 review, blocker 2).
        const item = this.queue.shift();
        if (!item) break;
        // Billing gate: VoiceOutput flushes banked text into synthesis on
        // this event — audio starts flowing into item.stream from here.
        this.emit({ type: 'cleared', id: item.id });
        const resource = createAudioResource(item.stream, { inputType: StreamType.Raw });
        this.current = { id: item.id, resource, startedAt: Date.now(), interruptedBy: null };
        this.player.play(resource);
        try {
          await entersState(this.player, AudioPlayerStatus.Playing, 10_000);
          this.emit({ type: 'started', id: item.id });
          await entersState(this.player, AudioPlayerStatus.Idle, 300_000);
        } catch (err) {
          console.error(`[discord-mcpl voice] playback: ${(err as Error).message}`);
          this.player.stop(true);
        }
        const cur = this.current;
        this.current = null;
        const playedMs = Math.round(resource.playbackDuration);
        this.emit(cur?.interruptedBy
          ? { type: 'interrupted', id: item.id, playedMs, by: cur.interruptedBy }
          : { type: 'finished', id: item.id, playedMs });
      }
    } finally {
      this.playing = false;
    }
  }

  private emit(ev: SinkEvent): void {
    for (const fn of this.eventFns) { try { fn(ev); } catch { /* consumer's */ } }
  }
}

/** Discord snowflakes are u64 decimal strings; numeric compare via length
 *  then lexicographic (avoids BigInt on hot paths and non-numeric ids in
 *  tests). */
export function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
