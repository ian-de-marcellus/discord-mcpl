/**
 * Live smoke test for the voice physics layer — no MCPL host needed.
 *
 * Drives VoiceOutput + DiscordVoiceSink directly: type a line on stdin, the
 * bot speaks it in the voice channel. While it speaks, talk over it — you
 * should hear it stop within ~300 ms, and the interruption report (voiced/
 * unvoiced split, who cut in) prints here. Start talking BEFORE pressing
 * enter to watch carrier-sense hold the utterance until you've been silent
 * for the hold-off.
 *
 * Usage (from discord-mcpl/):
 *   env $(grep -v '^#' .env.voice-test | xargs) npx tsx scripts/voice-smoke.ts --list
 *   env $(grep -v '^#' .env.voice-test | xargs) npx tsx scripts/voice-smoke.ts \
 *     --guild <guildId> --vc <voiceChannelId> [--voice Opus4]
 *
 * --list: print every guild + voice channel the bot can see, then exit.
 */
import { createInterface } from 'node:readline';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { ElevenLabsTtsProvider, loadRegistry, resolveVoice } from '@animalabs/voice-kit';
import { DiscordVoiceSink, VoiceOutput } from '../src/voice.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TOKEN = process.env.DISCORD_TOKEN;
const ELEVEN = process.env.ELEVENLABS_API_KEY;
const REGISTRY = process.env.DISCORD_VOICE_REGISTRY_FILE;
if (!TOKEN) { console.error('DISCORD_TOKEN missing'); process.exit(1); }

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
  console.log(`[smoke] logged in as ${client.user?.tag} (${client.user?.id})`);

  if (process.argv.includes('--list')) {
    for (const [, guild] of client.guilds.cache) {
      console.log(`guild ${guild.id}  ${guild.name}`);
      const chans = await guild.channels.fetch();
      for (const [, ch] of chans) {
        if (ch?.type === ChannelType.GuildVoice) console.log(`  vc   ${ch.id}  🔊 ${ch.name}`);
        if (ch?.type === ChannelType.GuildText) console.log(`  text ${ch.id}  # ${ch.name}`);
      }
    }
    process.exit(0);
  }

  const guildId = arg('guild');
  const vcId = arg('vc');
  if (!guildId || !vcId) { console.error('need --guild and --vc (or --list to discover)'); process.exit(1); }
  if (!ELEVEN || !REGISTRY) { console.error('ELEVENLABS_API_KEY / DISCORD_VOICE_REGISTRY_FILE missing'); process.exit(1); }

  const registry = loadRegistry(REGISTRY);
  const voiceName = arg('voice') ?? 'Opus4';
  const voice = resolveVoice(registry, voiceName);
  if (!voice) { console.error(`no registry voice "${voiceName}"`); process.exit(1); }
  console.log(`[smoke] speaking as registry voice "${voiceName}"`);

  const vadDb = Number(process.env.DISCORD_VOICE_VAD_DB);
  const sink = new DiscordVoiceSink(Number.isFinite(vadDb) ? vadDb : undefined);
  await sink.connect(client, guildId, vcId);

  // Narrate the physics as it happens.
  sink.gate.onSpeakerStart((s) =>
    console.log(`  [carrier] + ${s.bot ? 'BOT' : 'human'} SPEECH: ${s.username ?? s.userId}`));
  // Live level meter: once per second per speaker, peak dBFS — calibrate
  // DISCORD_VOICE_VAD_DB against what your room actually measures.
  const peaks = new Map<string, number>();
  sink.onLevel((userId, db) => {
    if (db > (peaks.get(userId) ?? -Infinity)) peaks.set(userId, db);
  });
  setInterval(() => {
    for (const [u, db] of peaks) console.log(`  [level] ${u}: peak ${db === -Infinity ? '-inf' : db.toFixed(1)} dBFS`);
    peaks.clear();
  }, 1000).unref();
  // Gate transitions: sample fast, print only busy↔clear edges with timing.
  let wasBusy = false; let since = Date.now();
  setInterval(() => {
    const b = sink.gate.busy();
    if (b !== wasBusy) {
      const held = ((Date.now() - since) / 1000).toFixed(1);
      console.log(`  [gate] ${wasBusy ? 'BUSY' : 'clear'} for ${held}s → ${b ? 'BUSY' : 'clear'}`);
      wasBusy = b; since = Date.now();
    }
  }, 100).unref();
  sink.onEvent((ev) => {
    if (ev.type === 'started') console.log(`  [sink] ▶ ${ev.id} playing`);
    else console.log(`  [sink] ■ ${ev.id} ${ev.type} after ${ev.playedMs}ms`);
  });

  const provider = new ElevenLabsTtsProvider(ELEVEN, registry.ttsModel ?? 'eleven_multilingual_v2');
  const out = new VoiceOutput({ textChannels: null }, provider, voice, sink);
  out.onReport((r) => {
    console.log(`\n[report] ${r.inferenceId}: ${r.status}${r.estimated ? ' (estimated boundary)' : ''}`);
    if (r.interruptedBy) console.log(`  cut off by: ${r.interruptedBy.username ?? r.interruptedBy.userId}${r.interruptedBy.bot ? ' (bot)' : ''}`);
    console.log(`  voiced   : "${r.voicedText}"`);
    console.log(`  unvoiced : "${r.unvoicedText}"\n`);
  });

  console.log('[smoke] ready — type a line to speak it; empty line = long test paragraph; Ctrl+C quits');
  const LONG = 'Alright, here is a deliberately long utterance so that you have plenty of time ' +
    'to interrupt me in the middle of a sentence. I am going to keep talking about nothing ' +
    'in particular, enumerating the physics rules: carrier sense, random hold-off, human ' +
    'barge-in, and deterministic bot collision yield, until somebody in this channel starts ' +
    'speaking, at which point I should stop within a third of a second and file an exact ' +
    'report about which of these words were actually heard and which were lost.';
  let n = 0;
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim() || LONG;
    const id = `utt${++n}`;
    console.log(`  [say] ${id} (${text.length} chars) — queued`);
    out.handleChunk(id, `discord:${guildId}:${vcId}`, text);
    out.handleComplete(id);
  });
});

void client.login(TOKEN);
