/**
 * Voice env detection, dependency-free by design: this module must import
 * NOTHING beyond node built-ins, so index.ts can decide whether voice is
 * configured without touching ./voice.js — whose top-level voice-kit import
 * would make every discord-mcpl instance hard-require @animalabs/voice-kit
 * at startup, voice or not. Fleet boxes deploy by pull + tsc with symlinked
 * packages; a resolvable-only-after-install dependency is a hard-down at the
 * next restart for residents that never asked for voice (#28 review).
 */

/** Default voiced threshold (dBFS) for the carrier VAD. Live finding: a
 *  client with noise suppression off transmits CONTINUOUSLY — packet
 *  presence reads as "speaking" forever. The carrier is defined by acoustic
 *  ENERGY; override per deployment with DISCORD_VOICE_VAD_DB. */
export const VAD_THRESHOLD_DB = -45;

export interface VoiceEnv {
  guildId: string;
  voiceChannelId: string;
  registryPath: string;
  voiceName: string;
  textChannels: string[] | null;
  elevenKey: string;
  /** Voiced threshold (dBFS) for the carrier VAD; default -45. */
  vadThresholdDb: number;
  /** Max queue wait before an utterance is dropped unspoken with an
   *  'expired' receipt (DISCORD_VOICE_MAX_HOLD_MS). Null = wait forever. */
  maxHoldMs: number | null;
}

/** Read voice config from env; null = voice not configured (the common case). */
export function voiceEnv(): VoiceEnv | null {
  const voiceChannelId = process.env.DISCORD_VOICE_CHANNEL_ID;
  if (!voiceChannelId) return null;
  const guildId = process.env.DISCORD_VOICE_GUILD_ID;
  const registryPath = process.env.DISCORD_VOICE_REGISTRY_FILE;
  const voiceName = process.env.DISCORD_VOICE_NAME;
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const missing = [
    !guildId && 'DISCORD_VOICE_GUILD_ID',
    !registryPath && 'DISCORD_VOICE_REGISTRY_FILE',
    !voiceName && 'DISCORD_VOICE_NAME',
    !elevenKey && 'ELEVENLABS_API_KEY',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`[discord-mcpl voice] DISCORD_VOICE_CHANNEL_ID set but missing: ${missing.join(', ')} — voice disabled`);
    return null;
  }
  const channels = (process.env.DISCORD_VOICE_TEXT_CHANNELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const vadDb = Number(process.env.DISCORD_VOICE_VAD_DB);
  const maxHold = Number(process.env.DISCORD_VOICE_MAX_HOLD_MS);
  return {
    guildId: guildId!, voiceChannelId, registryPath: registryPath!, voiceName: voiceName!,
    textChannels: channels.length ? channels : null, elevenKey: elevenKey!,
    vadThresholdDb: Number.isFinite(vadDb) ? vadDb : VAD_THRESHOLD_DB,
    maxHoldMs: Number.isFinite(maxHold) && maxHold > 0 ? maxHold : null,
  };
}
