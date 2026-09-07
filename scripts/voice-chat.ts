/**
 * Live voice conversation harness: humans talk in a Discord voice channel,
 * Claude (Sonnet 4.5) answers in voice — under the physics rules — and the
 * whole exchange leaves a text trail in the voice channel's built-in chat.
 *
 * The transcript-ordering protocol (per Antra's design):
 *  - When a human starts speaking, the bot POSTS a message to the voice
 *    channel's text chat immediately ("🎙️ name: …") — so Discord's message
 *    ORDER reflects utterance START order — then EDITS it as the STT
 *    transcript grows/revises, finalizing when they stop. Revision-friendly,
 *    matching voice-kit's "revision is normal" transcript contract.
 *  - The bot's own speech gets the same treatment: message posted when it
 *    starts speaking, edited at the end to reflect what was ACTUALLY heard —
 *    an interrupted utterance shows the voiced prefix, the unvoiced tail
 *    struck through. Other models read this channel and know exactly what
 *    was said, by whom, in what order.
 *
 * Conversation loop: utterance ends → (debounce for follow-ons) → history →
 * Claude streaming → deltas feed TTS (physics gates playback; barge-in
 * aborts both playback AND the model stream) → interruption reports edit
 * the message and annotate history so the model knows what the room heard.
 *
 * Usage (from discord-mcpl/):
 *   env $(grep -v '^#' .env.voice-test | xargs) ./node_modules/.bin/tsx \
 *     scripts/voice-chat.ts --guild <id> --vc <id> [--voice Opus4] [--model claude-sonnet-4-5]
 */
import Anthropic from '@anthropic-ai/sdk';
import { Client, GatewayIntentBits, type TextBasedChannel } from 'discord.js';
import {
  ElevenLabsTtsProvider, ScribeSttProvider, downmixStereoToMono,
  loadRegistry, resolveVoice, type SttSession,
} from '@animalabs/voice-kit';
import { DiscordVoiceSink, VoiceOutput, type SpeakerInfo } from '../src/voice.js';

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const TOKEN = process.env.DISCORD_TOKEN!;
const ELEVEN = process.env.ELEVENLABS_API_KEY!;
const REGISTRY = process.env.DISCORD_VOICE_REGISTRY_FILE!;
const GUILD = arg('guild')!;
const VC = arg('vc')!;
const MODEL = arg('model', 'claude-sonnet-4-5')!;
const VOICE_NAME = arg('voice', 'Opus4')!;
if (!TOKEN || !ELEVEN || !REGISTRY || !GUILD || !VC) {
  console.error('missing env/args'); process.exit(1);
}

/** Silence gap that ends a spoken utterance (audio-flow based). */
const UTTERANCE_END_MS = 900;
/** Wait after an utterance ends before responding (follow-on grace). */
const TURN_DEBOUNCE_MS = 1200;
/** Min interval between Discord message edits (rate-limit hygiene). */
const EDIT_INTERVAL_MS = 1500;

const SYSTEM = `You are ${VOICE_NAME}, speaking OUT LOUD in a Discord voice channel via TTS, \
in the first live test of connectome's voice physics layer (carrier-sense, human barge-in, \
interruption accounting) built today with Antra. Your words are heard, not read.

Speak accordingly: conversational, brief (a few sentences unless asked for more), no markdown, \
no lists, no emoji — punctuation and sentence rhythm are your only formatting. It's fine to be \
playful and to have opinions.

Turn-taking physics you live under: you never talk over a human; if someone speaks while you \
are speaking, you are cut off mid-word and a report tells you exactly which of your words were \
voiced and which were lost. User turns may note "[interrupted you after: ...]" — that means the \
rest of that sentence was never heard; don't refer to unvoiced content as if it was said.`;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const anthropic = new Anthropic(); // ANTHROPIC_API_KEY from env

client.once('ready', async () => {
  console.log(`[chat] logged in as ${client.user?.tag}, model ${MODEL}`);
  const registry = loadRegistry(REGISTRY);
  const voice = resolveVoice(registry, VOICE_NAME);
  if (!voice) { console.error(`no registry voice "${VOICE_NAME}"`); process.exit(1); }

  const sink = new DiscordVoiceSink(Number(process.env.DISCORD_VOICE_VAD_DB) || undefined);
  await sink.connect(client, GUILD, VC);
  const tts = new ElevenLabsTtsProvider(ELEVEN, registry.ttsModel ?? 'eleven_multilingual_v2');
  const out = new VoiceOutput({ textChannels: null }, tts, voice, sink);
  const stt = new ScribeSttProvider(ELEVEN);

  // Voice channels ARE text channels — post the transcript trail right there.
  const chat = (await client.channels.fetch(VC)) as TextBasedChannel & { send: (m: string) => Promise<import('discord.js').Message> };

  // ── Rate-limited message editor ─────────────────────────────────────────
  function makeEditor(msg: import('discord.js').Message) {
    let last = 0; let pending: string | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (pending === null) return;
      const text = pending; pending = null; last = Date.now();
      msg.edit(text.slice(0, 1900)).catch(() => {});
    };
    return {
      edit(text: string) {
        pending = text;
        const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - last));
        if (!timer) timer = setTimeout(() => { timer = null; flush(); }, wait);
      },
      final(text: string) {
        if (timer) { clearTimeout(timer); timer = null; }
        pending = text; flush();
      },
    };
  }

  // ── Conversation state ──────────────────────────────────────────────────
  const history: Anthropic.MessageParam[] = [];
  let pendingUserLines: string[] = [];
  let turnTimer: ReturnType<typeof setTimeout> | null = null;
  let respNum = 0;
  let activeStream: { abort: () => void; id: string } | null = null;
  // Bot utterance accounting: id → { editor, fullText }
  const botMsgs = new Map<string, { editor: ReturnType<typeof makeEditor>; fullText: string }>();

  // ── Listening leg: per-speaker Scribe sessions, transmission-bounded ────
  interface Listener {
    stt: SttSession;
    editor: ReturnType<typeof makeEditor> | null;
    texts: Map<string, string>; // utteranceId → latest text
    lastAudio: number;
    closer: ReturnType<typeof setInterval>;
    speaker: SpeakerInfo;
  }
  const listeners = new Map<string, Listener>();

  function utteranceText(l: Listener): string {
    return [...l.texts.values()].join(' ').replace(/\s+/g, ' ').trim();
  }

  function openListener(speaker: SpeakerInfo): Listener {
    const session = stt.openSession({ sampleRateHz: 48000 });
    const l: Listener = { stt: session, editor: null, texts: new Map(), lastAudio: Date.now(), closer: null as never, speaker };
    session.onTranscript((t) => {
      l.texts.set(t.utteranceId, t.text);
      const text = utteranceText(l);
      if (!text) return;
      if (!l.editor) {
        // Post-on-start: ordering anchor for the room.
        chat.send(`🎙️ **${speaker.username ?? speaker.userId}**: …`)
          .then((m) => { l.editor = makeEditor(m); l.editor.edit(`🎙️ **${speaker.username ?? speaker.userId}**: ${text}`); })
          .catch(() => {});
      } else {
        l.editor.edit(`🎙️ **${speaker.username ?? speaker.userId}**: ${text}`);
      }
    });
    session.onError((e) => console.error(`[stt] ${speaker.username}: ${e.message}`));
    l.closer = setInterval(() => {
      if (Date.now() - l.lastAudio > UTTERANCE_END_MS) closeListener(speaker.userId);
    }, 200);
    listeners.set(speaker.userId, l);
    return l;
  }

  function closeListener(userId: string): void {
    const l = listeners.get(userId);
    if (!l) return;
    clearInterval(l.closer);
    listeners.delete(userId);
    l.stt.commit();
    // Give Scribe a beat to flush the final commit before closing + turn-taking.
    setTimeout(() => {
      l.stt.close();
      const text = utteranceText(l);
      const name = l.speaker.username ?? l.speaker.userId;
      if (l.editor) l.editor.final(`🎙️ **${name}**: ${text || '*(unintelligible)*'}`);
      if (!text) return;
      console.log(`[heard] ${name}: ${text}`);
      pendingUserLines.push(`${name}: ${text}`);
      scheduleTurn();
    }, 600);
  }

  sink.onSpeakerAudio((speaker, pcm48kStereo) => {
    if (speaker.bot) return; // v1: transcribe humans; bots post their own text
    const l = listeners.get(speaker.userId) ?? openListener(speaker);
    l.lastAudio = Date.now();
    l.stt.sendAudio(downmixStereoToMono(pcm48kStereo));
  });

  // ── Speaking leg: Claude streaming → TTS under physics ─────────────────
  function scheduleTurn(): void {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => { turnTimer = null; void respond(); }, TURN_DEBOUNCE_MS);
  }

  async function respond(): Promise<void> {
    if (pendingUserLines.length === 0) return;
    if (activeStream) return; // still talking; new speech will barge in and re-schedule
    const userText = pendingUserLines.join('\n');
    pendingUserLines = [];
    history.push({ role: 'user', content: userText });

    const id = `resp${++respNum}`;
    let full = '';
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: history,
    });
    activeStream = { abort: () => stream.abort(), id };

    const msg = await chat.send(`🔊 **${VOICE_NAME}**: …`).catch(() => null);
    const editor = msg ? makeEditor(msg) : null;
    if (editor) botMsgs.set(id, { editor, fullText: '' });

    stream.on('text', (delta) => {
      full += delta;
      const entry = botMsgs.get(id);
      if (entry) { entry.fullText = full; entry.editor.edit(`🔊 **${VOICE_NAME}**: ${full}`); }
      out.handleChunk(id, `discord:${GUILD}:${VC}`, delta);
    });

    try {
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') console.log('[chat] model refused');
      history.push({ role: 'assistant', content: full || '…' });
      console.log(`[said→queue] ${full.slice(0, 100)}…`);
    } catch (err) {
      // Aborted (barge-in) or API error. History gets what was actually voiced
      // via the utterance report below; if nothing was, drop the turn.
      if (!(err as Error).message?.includes('abort')) console.error('[chat] stream error:', (err as Error).message);
      if (full && history[history.length - 1]?.role !== 'assistant') {
        history.push({ role: 'assistant', content: full });
      }
    } finally {
      out.handleComplete(id);
      activeStream = null;
      // Anything said while we were generating gets answered now.
      if (pendingUserLines.length) scheduleTurn();
    }
  }

  // ── Interruption accounting → chat message + history truth ─────────────
  out.onReport((r) => {
    const entry = botMsgs.get(r.inferenceId);
    if (r.status === 'interrupted') {
      // Abort the model stream if it's still generating this utterance.
      if (activeStream?.id === r.inferenceId) activeStream.abort();
      const who = r.interruptedBy?.username ?? 'someone';
      if (entry) {
        const cut = r.unvoicedText ? ` ~~${r.unvoicedText.slice(0, 500)}~~` : '';
        entry.editor.final(`🔊 **${VOICE_NAME}**: ${r.voicedText}${cut}\n-# ✂️ interrupted by ${who}${r.estimated ? ' (approx.)' : ''}`);
      }
      // Rewrite history so the model knows what the room actually heard.
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]!.role === 'assistant') {
          history[i] = { role: 'assistant', content: r.voicedText || '…' };
          break;
        }
      }
      pendingUserLines.push(`[you were interrupted by ${who} after: "${r.voicedText.slice(-120)}"]`);
      console.log(`[report] interrupted by ${who}; voiced ${r.voicedText.length}/${r.voicedText.length + r.unvoicedText.length} chars`);
    } else if (entry) {
      entry.editor.final(`🔊 **${VOICE_NAME}**: ${entry.fullText}`);
    }
    botMsgs.delete(r.inferenceId);
  });

  console.log('[chat] live — speak in the channel');
});

void client.login(TOKEN);
