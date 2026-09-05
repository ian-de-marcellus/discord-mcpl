#!/usr/bin/env node
/**
 * Discord MCPL server — CLI entry point.
 *
 * Usage:
 *   discord-mcpl --stdio           # MCP-compatible stdio transport
 *   discord-mcpl --tcp <port>      # TCP transport for MCPL hosts
 *   discord-mcpl --stdio --cc      # + Claude Code channel dialect: for plain
 *                                  # MCP clients, advertise claude/channel and
 *                                  # push wakes via notifications/claude/channel
 *                                  # (no effect on MCPL clients). Also via
 *                                  # DISCORD_CC=1.
 *
 * Environment:
 *   DISCORD_TOKEN     - Required: Discord bot token
 *   DISCORD_GUILD_ID  - Optional: Comma-separated guild ID filter. Each entry
 *                       is `guildId` (all channels) or `guildId:chanId+chanId`
 *                       (whitelist those channels + their threads only)
 *   DISCORD_DM_USERS  - Optional: Comma-separated user ID whitelist for DMs.
 *                       When set, DMs from anyone else are dropped.
 *   DISCORD_ADMIN_USERS - Optional: Comma-separated user IDs allowed to use
 *                       admin slash commands (/undo). Unset = nobody.
 *   DISCORD_FILTERS_FILE - Optional: path to a JSON file holding the guild/
 *                       channel + DM whitelists and the operator-maintained
 *                       suppressedReactionEmojis list (see filters.ts for
 *                       schema). When set, the file wins over
 *                       DISCORD_GUILD_ID / DISCORD_DM_USERS (and is seeded
 *                       from them if absent), and edits to it are
 *                       HOT-RELOADED within ~3s — no restart. Also enables
 *                       the filters_get/filters_update agent tools.
 *   DISCORD_SUPPRESS_REACTION_EMOJIS - Deprecated compat source for
 *                       reaction suppression (comma-separated). Seeds the
 *                       filters file's suppressedReactionEmojis key on
 *                       first materialization; ignored once a filters file
 *                       carries the key. Process-static: read once at
 *                       startup, changes require a restart (hot reload
 *                       belongs to the file plane). Retires per issue #16.
 *   DISCORD_SUPPRESSED_REACTIONS_BASELINE - Host-injected protective
 *                       baseline for reaction suppression (comma-
 *                       separated). Applies (and seeds the filters file on
 *                       first materialization) only when no operator
 *                       configuration exists: a file key — including an
 *                       explicit [] — or the legacy env above always wins,
 *                       never unioned. Intended to be set by host
 *                       composition from the Agent Framework's annotation
 *                       map; standalone deployments leave it unset.
 *                       Process-static, not deprecated.
 */

import * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';
import { DiscordAdapter } from './discord-adapter.js';
import { DiscordMcplServer } from './server.js';
import {
  resolveStartupFilters,
  loadFiltersFile,
  filtersFileMtime,
  FiltersFilePollTracker,
} from './filters.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useStdio = args.includes('--stdio');
  const ccMode = args.includes('--cc') || process.env.DISCORD_CC === '1';
  const tcpIdx = args.indexOf('--tcp');
  const tcpPort = tcpIdx >= 0 ? parseInt(args[tcpIdx + 1], 10) : undefined;

  if (!useStdio && !tcpPort) {
    console.error('Usage: discord-mcpl --stdio | --tcp <port>');
    process.exit(1);
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN environment variable is required');
    process.exit(1);
  }

  // Event filters: env vars are the seed; DISCORD_FILTERS_FILE (when set)
  // becomes the live source of truth and is hot-reloaded below. Seeding
  // happens only when the file is genuinely absent — an existing file that
  // fails to parse is left untouched (see resolveStartupFilters).
  const filtersFile = process.env.DISCORD_FILTERS_FILE;
  const { filters, fileBroken: filtersFileBroken } = resolveStartupFilters(filtersFile);

  // Connect Discord first
  const discord = new DiscordAdapter({
    token,
    guildIds: filters.guildIds,
    guildChannels: filters.guildChannels,
    dmUsers: filters.dmUsers,
  });

  const discordReady = new Promise<void>((resolve) => {
    discord.onReady(() => {
      console.error(`[discord-mcpl] Discord connected as bot ${discord.botUserId}`);
      resolve();
    });
  });

  await discord.connect();
  await discordReady;

  const server = new DiscordMcplServer(discord, { ccMode });

  // The filters plane state (whitelists + reaction suppression share one
  // desired/effective/status lifecycle): hand it the startup filters, or
  // the failure if the file was broken before anything good was ever
  // loaded — which fails closed for reactions; see DiscordFiltersState.
  if (filtersFileBroken) {
    server.filtersState.markBroken('invalid');
  } else {
    server.filtersState.applyParsed(filters);
  }

  // Hot-reload: poll the filters file and apply changes live. Covers edits
  // from any source (human, ops tooling, the filters_update tool — which
  // also applies its change directly; the poller is then an idempotent
  // no-op re-apply). Parse failures keep the previous filters (fail-safe)
  // and mark the whole plane's desired state invalid. A file missing for
  // two consecutive polls (one poll of grace for non-atomic editors) marks
  // the plane 'missing' — a deleted desired config must never keep
  // reporting as healthy — and a reappearing file force-reloads even with
  // a preserved mtime (restored backups can carry different bytes under
  // identical timestamps).
  if (filtersFile) {
    const tracker = new FiltersFilePollTracker(filtersFileMtime(filtersFile));
    const poll = setInterval(() => {
      const action = tracker.observe(filtersFileMtime(filtersFile));
      if (action === 'none') return;
      if (action === 'missing') {
        if (server.filtersState.markBroken('missing')) {
          console.error(
            `[discord-mcpl] filters file ${filtersFile} is MISSING — plane is stale; ` +
              'last-known-good filters stay in force until the file reappears',
          );
        }
        return;
      }
      const next = loadFiltersFile(filtersFile);
      if (!next) {
        if (server.filtersState.markBroken('invalid')) {
          console.error(
            `[discord-mcpl] filters file changed but is unparseable — keeping previous filters (${filtersFile})`,
          );
        }
        return;
      }
      const diff = discord.updateFilters(next);
      server.filtersState.applyParsed(next);
      console.error(
        `[discord-mcpl] filters hot-reloaded from ${filtersFile} ` +
          `(guilds +${diff.addedGuilds.length}/-${diff.removedGuilds.length})`,
      );
      if (diff.addedGuilds.length) {
        // Newly-allowed guilds: make their channels known to the host.
        server.applyFilterChange();
      }
    }, 3000);
    poll.unref();
  }

  // Register slash commands (/undo) and wire the interaction handler.
  // Fail-open: command registration needs the applications.commands scope;
  // a failure shouldn't take down the surface.
  try {
    await server.setupSlashCommands();
    console.error('[discord-mcpl] Slash commands registered');
  } catch (err) {
    console.error('[discord-mcpl] Slash command setup failed:', (err as Error).message);
  }

  if (useStdio) {
    // Stdio transport — single client, MCP-compatible
    // Log to stderr (stdout is the protocol channel)
    console.error('[discord-mcpl] Starting on stdio');
    const conn = McplConnection.fromStreams(process.stdin, process.stdout);
    await server.serve(conn);
  } else if (tcpPort) {
    // TCP transport — single client
    console.error(`[discord-mcpl] Listening on TCP port ${tcpPort}`);
    const tcpServer = net.createServer();
    tcpServer.listen(tcpPort, '127.0.0.1');

    await new Promise<void>((resolve) => tcpServer.once('listening', resolve));

    // Accept and serve one connection at a time
    while (true) {
      const conn = await McplConnection.acceptTcp(tcpServer);
      console.error('[discord-mcpl] Client connected');
      await server.serve(conn);
      console.error('[discord-mcpl] Client disconnected, waiting for next...');
    }
  }
}

main().catch((err) => {
  console.error('[discord-mcpl] Fatal error:', err);
  process.exit(1);
});
