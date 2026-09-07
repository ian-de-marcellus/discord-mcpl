// VoiceOutput: chunk routing, lazy per-inference streams, channel filtering,
// completion, the advisory-only discipline (this module never posts), and
// the physics accounting: interruption → voiced/unvoiced split reports.
// CarrierGate: carrier-sense hold-off behavior.
// Provider + sink injected; no Discord, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import {
  CarrierGate, VoiceOutput, compareSnowflakes,
  type PcmSink, type SinkEvent, type SinkItem, type UtteranceReport,
} from '../src/voice.js';
import type { TtsAlignment, TtsProvider, TtsStream, TtsVoice } from '@animalabs/voice-kit';

class FakeStream implements TtsStream {
  sent: string[] = [];
  ended = false;
  aborted = false;
  private audioFns: Array<(b: Buffer) => void> = [];
  private alignFns: Array<(a: TtsAlignment) => void> = [];
  private endFns: Array<() => void> = [];
  private errorFns: Array<(e: Error) => void> = [];
  sendText(d: string): void { this.sent.push(d); }
  end(): void { this.ended = true; for (const f of this.endFns) f(); }
  abort(): void { this.aborted = true; }
  onAudio(f: (b: Buffer) => void): void { this.audioFns.push(f); }
  onAlignment(f: (a: TtsAlignment) => void): void { this.alignFns.push(f); }
  onEnd(f: () => void): void { this.endFns.push(f); }
  onError(f: (e: Error) => void): void { this.errorFns.push(f); }
  emitAudio(b: Buffer): void { for (const f of this.audioFns) f(b); }
  emitAlignment(a: TtsAlignment): void { for (const f of this.alignFns) f(a); }
  emitError(e: Error): void { for (const f of this.errorFns) f(e); }
}

class FakeProvider implements TtsProvider {
  readonly name = 'fake';
  readonly outputRateHz = 44100;
  streams: FakeStream[] = [];
  openStream(_v: TtsVoice): TtsStream {
    const s = new FakeStream();
    this.streams.push(s);
    return s;
  }
}

class FakeSink implements PcmSink {
  played: SinkItem[] = [];
  cancelled: string[] = [];
  private clearedIds = new Set<string>();
  private fns: Array<(ev: SinkEvent) => void> = [];
  play(item: SinkItem): void { this.played.push(item); }
  cancel(id: string): boolean {
    // Mirrors DiscordVoiceSink: only still-queued (never-cleared) items can
    // be cancelled; a cleared/unknown id loses the race.
    if (this.clearedIds.has(id) || !this.played.some((p) => p.id === id)) return false;
    this.cancelled.push(id);
    return true;
  }
  onEvent(fn: (ev: SinkEvent) => void): void { this.fns.push(fn); }
  emit(ev: SinkEvent): void {
    if (ev.type === 'cleared') this.clearedIds.add(ev.id);
    for (const f of this.fns) f(ev);
  }
  /** Carrier cleared this item — the billing gate. */
  clear(id: string): void { this.emit({ type: 'cleared', id }); }
}

const VOICE: TtsVoice = { voiceId: 'v1' };

function setup(textChannels: string[] | null = null) {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels }, provider, VOICE, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));
  return { provider, sink, out, reports };
}

/** Alignment where char i plays [i*100, (i+1)*100) ms. */
function evenAlignment(text: string, msPerChar = 100): TtsAlignment {
  const chars = [...text];
  return {
    chars,
    startMs: chars.map((_, i) => i * msPerChar),
    durationMs: chars.map(() => msPerChar),
  };
}

test('billing gate: socket pre-opens free, text banks until cleared, then streams live', () => {
  const { provider, sink, out } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'Hello ');
  out.handleChunk('inf1', 'discord:g:100', 'there.');
  assert.equal(provider.streams.length, 1);        // socket pre-opened (free)
  assert.equal(sink.played.length, 1);             // queued for playback at open
  assert.equal(sink.played[0]!.id, 'inf1');
  assert.deepEqual(provider.streams[0]!.sent, []); // zero characters billed while queued
  sink.clear('inf1');
  assert.deepEqual(provider.streams[0]!.sent, ['Hello there.']); // one flush
  out.handleChunk('inf1', 'discord:g:100', ' More.');
  assert.deepEqual(provider.streams[0]!.sent, ['Hello there.', ' More.']); // live now
  assert.equal(provider.streams[0]!.ended, false);
  out.handleComplete('inf1');
  assert.equal(provider.streams[0]!.ended, true);
});

test('complete while queued: end is deferred to the flush', () => {
  const { provider, sink, out } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'Whole thing.');
  out.handleComplete('inf1');
  assert.equal(provider.streams[0]!.ended, false); // nothing sent yet — nothing to end
  sink.clear('inf1');
  assert.deepEqual(provider.streams[0]!.sent, ['Whole thing.']);
  assert.equal(provider.streams[0]!.ended, true);
});

test('channel filter: non-voiced channels are skipped for the whole inference', () => {
  const { provider, sink, out } = setup(['777']);
  out.handleChunk('inf1', 'discord:g:999', 'not voiced ');
  out.handleChunk('inf1', 'discord:g:999', 'still not');
  assert.equal(provider.streams.length, 0);
  out.handleChunk('inf2', 'discord:g:777', 'voiced');
  assert.equal(provider.streams.length, 1);
  sink.clear('inf2');
  assert.deepEqual(provider.streams[0]!.sent, ['voiced']);
});

test('concurrent inferences get separate streams; audio resampled 44.1k→48k stereo', async () => {
  const { provider, sink, out } = setup();
  out.handleChunk('a', 'discord:g:1', 'A');
  out.handleChunk('b', 'discord:g:1', 'B');
  assert.equal(provider.streams.length, 2);
  assert.equal(sink.played.length, 2);

  // 100 samples of 44.1k mono → floor(100*48000/44100)=108 frames of stereo (432 bytes)
  const chunks: Buffer[] = [];
  sink.played[0]!.stream.on('data', (c: Buffer) => chunks.push(c));
  provider.streams[0]!.emitAudio(Buffer.alloc(200));
  provider.streams[0]!.end();
  await new Promise((r) => setTimeout(r, 20));
  const total = Buffer.concat(chunks);
  assert.equal(total.length, Math.floor((100 * 48000) / 44100) * 4);
});

test('stop() aborts in-flight streams', () => {
  const { provider, out } = setup();
  out.handleChunk('a', 'discord:g:1', 'never finishes');
  out.stop();
  assert.equal(provider.streams[0]!.aborted, true);
});

test('unparseable channel ids are skipped, never throw', () => {
  const { provider, out } = setup();
  out.handleChunk('x', 'not-a-channel', 'text');
  assert.equal(provider.streams.length, 0);
});

// ── Physics accounting ──────────────────────────────────────────────────────

test('interruption: alignment-exact voiced/unvoiced split, TTS aborted, later chunks dropped', () => {
  const { provider, sink, out, reports } = setup();
  const text = 'Hello there, friend.';
  out.handleChunk('inf1', 'discord:g:100', text);
  provider.streams[0]!.emitAlignment(evenAlignment(text)); // char i midpoint = i*100+50

  const by = { userId: 'u9', username: 'antra', bot: false };
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 550, by });

  assert.equal(reports.length, 1);
  const r = reports[0]!;
  assert.equal(r.status, 'interrupted');
  assert.equal(r.estimated, false);
  assert.equal(r.voicedText, 'Hello '); // midpoints 50..550 → 6 chars heard
  assert.equal(r.unvoicedText, 'there, friend.');
  assert.deepEqual(r.interruptedBy, by);
  assert.equal(provider.streams[0]!.aborted, true);

  // The inference is dead: post-interruption chunks must not reopen TTS.
  out.handleChunk('inf1', 'discord:g:100', ' more prose');
  assert.equal(provider.streams.length, 1);
});

test('interruption without alignment: proportional estimate, flagged', () => {
  const { provider, sink, out, reports } = setup();
  out.handleChunk('inf1', 'discord:g:100', '0123456789'); // 10 chars
  // 44100 samples = 1000 ms of source audio (PCM16 mono 44.1k = 2 bytes/sample)
  provider.streams[0]!.emitAudio(Buffer.alloc(88200));
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 500, by: { userId: 'u1', bot: false } });

  const r = reports[0]!;
  assert.equal(r.estimated, true);
  assert.equal(r.voicedText, '01234');
  assert.equal(r.unvoicedText, '56789');
});

test('interruption before any audio: everything unvoiced', () => {
  const { sink, out, reports } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'never heard');
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 0, by: { userId: 'u1', bot: true } });
  const r = reports[0]!;
  assert.equal(r.voicedText, '');
  assert.equal(r.unvoicedText, 'never heard');
});

test('clean finish after complete snaps to fully voiced', () => {
  const { provider, sink, out, reports } = setup();
  const text = 'Short and sweet.';
  out.handleChunk('inf1', 'discord:g:100', text);
  provider.streams[0]!.emitAlignment(evenAlignment(text));
  provider.streams[0]!.emitAudio(Buffer.alloc(88200)); // 1000 ms
  out.handleComplete('inf1');
  // Played ≈ synthesized (within slack) → full text, no phantom tail.
  sink.emit({ type: 'finished', id: 'inf1', playedMs: 900 });

  const r = reports[0]!;
  assert.equal(r.status, 'spoken');
  assert.equal(r.voicedText, text);
  assert.equal(r.unvoicedText, '');
});

test('truncated finish (TTS died early) reports the unvoiced tail', () => {
  const { provider, sink, out, reports } = setup();
  const text = 'This sentence will be cut off midway through.'; // 45 chars
  out.handleChunk('inf1', 'discord:g:100', text);
  provider.streams[0]!.emitAlignment(evenAlignment(text)); // 45 chars → 4500 ms
  provider.streams[0]!.emitAudio(Buffer.alloc(88200 * 5)); // pretend 5000 ms synthesized
  out.handleComplete('inf1');
  // Sink finished but only 2000 ms actually played (stream errored/ended early).
  sink.emit({ type: 'finished', id: 'inf1', playedMs: 2000 });

  const r = reports[0]!;
  assert.equal(r.status, 'spoken');
  assert.equal(r.voicedText, text.slice(0, 20)); // midpoints ≤2000ms → 20 chars
  assert.equal(r.unvoicedText, text.slice(20));
  assert.equal(r.estimated, false);
});

// ── Zero-cost-loser (convergence review, Sol 8/5) ───────────────────────────

test('zero-cost-loser pin: stopped while queued → provider received zero characters', () => {
  const { provider, out } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'never billed');
  out.stop();
  assert.deepEqual(provider.streams[0]!.sent, []);
  assert.equal(provider.streams[0]!.aborted, true);
});

test('interrupted while never cleared: report carries billedChars 0', () => {
  const { sink, out, reports } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'unbilled words');
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 0, by: { userId: 'u1', bot: true } });
  assert.equal(reports[0]!.billedChars, 0);
  assert.equal(reports[0]!.unvoicedText, 'unbilled words');
});

test('billedChars receipt: cleared-then-interrupted bills exactly the flushed text', () => {
  const { provider, sink, out, reports } = setup();
  const text = 'Hello there, friend.';
  out.handleChunk('inf1', 'discord:g:100', text);
  sink.clear('inf1');
  provider.streams[0]!.emitAlignment(evenAlignment(text));
  sink.emit({ type: 'interrupted', id: 'inf1', playedMs: 550, by: { userId: 'u9', bot: false } });
  assert.equal(reports[0]!.billedChars, text.length);
  assert.ok(reports[0]!.queuedMs >= 0);
});

test('socket pre-open is capped: deep-queue items open at clearance instead', () => {
  const { provider, sink, out } = setup();
  for (let i = 0; i < 5; i++) out.handleChunk('inf' + i, 'discord:g:100', 'text ' + i);
  assert.equal(provider.streams.length, 3); // PRE_OPEN_MAX sockets, not 5
  sink.clear('inf4');                       // deep item clears → opens now
  assert.equal(provider.streams.length, 4);
  assert.deepEqual(provider.streams[3]!.sent, ['text 4']);
});

test('socket died while queued: flush reopens a fresh stream and resends the bank', () => {
  const { provider, sink, out } = setup();
  out.handleChunk('inf1', 'discord:g:100', 'resent ');
  provider.streams[0]!.emitError(new Error('idle timeout')); // provider hung up pre-clearance
  out.handleChunk('inf1', 'discord:g:100', 'text');          // keeps banking
  sink.clear('inf1');
  assert.equal(provider.streams.length, 2);
  assert.deepEqual(provider.streams[0]!.sent, []);           // dead socket billed nothing
  assert.deepEqual(provider.streams[1]!.sent, ['resent text']);
});

test('maxHold expiry: dropped unspoken with an expired receipt, zero billed', async () => {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null, maxHoldMs: 20 }, provider, VOICE, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));
  out.handleChunk('inf1', 'discord:g:100', 'too late');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sink.cancelled, ['inf1']);
  assert.equal(reports.length, 1);
  const r = reports[0]!;
  assert.equal(r.status, 'expired');
  assert.equal(r.billedChars, 0);
  assert.equal(r.playedMs, 0);
  assert.equal(r.unvoicedText, 'too late');
  assert.ok(r.queuedMs >= 20);
  assert.deepEqual(provider.streams[0]!.sent, []);
  assert.equal(provider.streams[0]!.aborted, true);
  // The inference is dead: post-expiry chunks must not reopen anything.
  out.handleChunk('inf1', 'discord:g:100', 'late delta');
  assert.equal(provider.streams.length, 1);
});

test('cleared beats expiry: a cleared utterance is never expired', async () => {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null, maxHoldMs: 20 }, provider, VOICE, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));
  out.handleChunk('inf1', 'discord:g:100', 'quick');
  sink.clear('inf1');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sink.cancelled, []);
  assert.equal(reports.length, 0); // still active, awaiting playback outcome
  assert.deepEqual(provider.streams[0]!.sent, ['quick']);
});

// ── CarrierGate ─────────────────────────────────────────────────────────────

test('waitClear resolves only after silence + full hold-off', async () => {
  const gate = new CarrierGate();
  gate.speakingStart({ userId: 'u1', bot: false });

  let cleared = false;
  const p = gate.waitClear(10, 11).then(() => { cleared = true; });

  await new Promise((r) => setTimeout(r, 25));
  assert.equal(cleared, false); // still speaking → still held

  gate.speakingEnd('u1');
  await new Promise((r) => setTimeout(r, 25)); // > hold-off
  await p;
  assert.equal(cleared, true);
});

test('a speaker starting during hold-off restarts the wait', async () => {
  const gate = new CarrierGate();
  let cleared = false;
  void gate.waitClear(30, 31).then(() => { cleared = true; });

  await new Promise((r) => setTimeout(r, 10)); // inside hold-off
  gate.speakingStart({ userId: 'u2', bot: true }); // carrier reappears
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cleared, false); // held: speaker active

  gate.speakingEnd('u2');
  await new Promise((r) => setTimeout(r, 50)); // silence + fresh hold-off
  assert.equal(cleared, true);
});

test('onSpeakerStart fires for barge-in decisions; busy() tracks the set', () => {
  const gate = new CarrierGate();
  const starts: string[] = [];
  gate.onSpeakerStart((s) => starts.push(s.userId));
  assert.equal(gate.busy(), false);
  gate.speakingStart({ userId: 'a', bot: false });
  gate.speakingStart({ userId: 'b', bot: true });
  assert.equal(gate.busy(), true);
  gate.speakingEnd('a');
  assert.equal(gate.busy(), true);
  gate.speakingEnd('b');
  assert.equal(gate.busy(), false);
  assert.deepEqual(starts, ['a', 'b']);
});

test('sustained-speech debounce: blips never fire, real speech does', async () => {
  const gate = new CarrierGate();
  const sustained: string[] = [];
  gate.onSpeakerSustained(30, (s) => sustained.push(s.userId));

  // Blip: unmute pop — start then end well inside the debounce window.
  gate.speakingStart({ userId: 'blip', bot: false });
  await new Promise((r) => setTimeout(r, 10));
  gate.speakingEnd('blip');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(sustained, []); // pop ignored — utterance survives

  // Real speech: still on the carrier when the debounce lands.
  gate.speakingStart({ userId: 'talker', bot: false });
  await new Promise((r) => setTimeout(r, 45));
  assert.deepEqual(sustained, ['talker']);
});

test('rapid VAD re-trigger counts as sustained speech', async () => {
  const gate = new CarrierGate();
  const sustained: string[] = [];
  gate.onSpeakerSustained(30, (s) => sustained.push(s.userId));

  // Start, brief dropout, restart — speaker is present when the FIRST
  // start's debounce timer lands, so it fires: choppy speech is speech.
  gate.speakingStart({ userId: 'u', bot: false });
  await new Promise((r) => setTimeout(r, 10));
  gate.speakingEnd('u');
  await new Promise((r) => setTimeout(r, 5));
  gate.speakingStart({ userId: 'u', bot: false });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(sustained.includes('u'));
});

test('compareSnowflakes: numeric order via length-then-lex', () => {
  assert.ok(compareSnowflakes('99', '100') < 0);
  assert.ok(compareSnowflakes('101', '100') > 0);
  assert.equal(compareSnowflakes('100', '100'), 0);
});
