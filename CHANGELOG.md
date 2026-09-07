# Changelog

Notable operator-facing changes. Started 2026-07-29; earlier history lives
in the git log and PR descriptions.

## Unreleased

### Added

- **Claude Code channel dialect** (`--cc` / `DISCORD_CC=1`): a third
  delivery arm for plain-MCP clients. Initialize advertises
  `experimental['claude/channel']`; addressed messages (DMs, explicit
  mentions, a human's reply to the bot) push `notifications/claude/channel`
  wakes; subscribed ambient accrues (capped, `DISCORD_CC_CONTEXT_CAP`,
  default 80) and folds into the next wake; the reconnect sweep delivers its
  `<missed>` blocks through the same envelope. MCPL clients are untouched
  and `--cc` defers to MCPL at initialize. No new dependencies.
- **Read acknowledgement in cc mode** (`mark_read` tool): the watermark file
  now carries two anchors per channel, `watermarks` (forwarded) and `seen`
  (acknowledged). Under an MCPL host they move together as before. In cc
  mode `seen` advances only when the session calls `mark_read`, because a
  forwarded wake can land in a process whose inference then fails — the
  message must not be treated as read by a surface nobody read it through.
  Backscroll and the reconnect sweep anchor on `seen`, so an unacknowledged
  message resurfaces as `<missed>` on the next sweep and as
  `<unacknowledged>` on the next live wake for that channel. Every cc
  delivery ends with a footer naming the `mark_read` call it expects. A
  watermark file written before this change is read with `seen` seeded
  from `watermarks`, so upgrading does not replay history.
- **Host-injectable protective baseline for reaction suppression**
  (`DISCORD_SUPPRESSED_REACTIONS_BASELINE`): new deployments and
  never-configured installations default to the house classifier markers
  when host composition injects them. Precedence is strict and never
  unioned: a filters-file key (including an explicit `[]` = operator chose
  none) beats everything; the deprecated operator env beats the baseline;
  the baseline applies only when no operator configuration exists. The
  legacy env's PRESENCE wins even when its parsed list is empty or
  separator-only — the emergency filter treated an explicitly-empty env as
  OFF, and the baseline never reappears underneath an operator's off
  switch. This is a stated choice: the alternative (only a file `[]` can
  express none) would have changed existing emergency deployments'
  semantics.
  First materialization of the filters file writes the winning seed
  durably — including a present-but-empty legacy env, which is written as
  an explicit `[]` key so the operator's off survives env cleanup and
  future baseline injection. Lost configuration keeps the reviewed stale-LKG / fail-closed
  postures and never silently degrades back to the baseline — it is for
  never-configured, not for lost configuration. `filters_get` reports
  `source: "baseline-default"` (count/digest only, not deprecated). The
  Agent Framework owns the refusal-category→reaction map; host composition
  derives and injects the concrete set below the model line — standalone
  Discord deployments inject nothing and honestly report no protection.
- **Current reaction state on line-formatted transcripts** (issue #31): the
  reconnect `<missed>` sweep and the first-interaction backscroll now append
  a compact suffix — `[reactions: 😀 x2 (incl. me)]` — showing each
  message's current NET reaction aggregate, after the suppression
  projection, independent of the live `set_reaction_visibility` toggle
  (that opt-in governs ambient add/remove events; historical rendering is a
  current-state snapshot). No suffix means no visible reactions; state the
  adapter doesn't actually have (no resolver data, or a withhold-everything
  filters posture) renders an explicit `[reactions: unavailable]` marker
  rather than a false "none". Structured surfaces (`fetch_history` /
  `fetch_around` / backscroll metadata) are unchanged.

- **Reaction suppression on the filters plane** (issue #21):
  `suppressedReactionEmojis` in `DISCORD_FILTERS_FILE` names reaction
  markers that are filtered out of every model-visible surface — live
  reaction events (including their event ids), `fetch_history` /
  `fetch_around` results, and channel-open backscroll metadata — before any
  text or token is produced. Raw Discord state is untouched: projection, not
  deletion. The key is **operator-maintained**: `filters_update` has no
  parameter that can carry it (in either direction — configured markers
  never transit an agent turn), and resident guild/DM updates round-trip it
  unchanged. `filters_get` reports redacted state only: status
  (`not-configured` / `configured-empty` / `active` / `stale` /
  `unavailable`), entry count, full `sha256:` digest of the normalized set,
  source, and load time — never the entries. Matching is the emergency
  filter's semantics (VS-16/colon differences ignored; numeric snowflake
  entries also match custom emojis by id). A wrong-typed
  `suppressedReactionEmojis` (anything but a string array) invalidates the
  whole file load — a typo'd safety field must never silently degrade to
  "key absent".
  Desired-vs-effective state is reported for the WHOLE plane, not per key:
  `filters_get` gains a `plane` block (`live` / `stale` / `unavailable`,
  `desiredState: ok|invalid|missing`, full `sha256:` digest of the
  normalized effective filters, load time) because guild/DM whitelists go
  stale under exactly the same failures as suppression. Failure posture: a
  bad rewrite or file deletion after a good load keeps enforcing the
  last-known-good filters (process-lifetime only — a restart into a broken
  file does not resurrect them); a filters file that is configured but was
  never readable withholds ALL reactions (`unavailable`, history messages
  marked `reactionsUnavailable: true`) until repaired. The poller detects
  real file deletion (one poll of grace for non-atomic editors) and
  force-reloads a reappearing file even under a preserved mtime. A
  malformed filters file is never overwritten — not by the env seed at
  startup, and not by `filters_update`, which refuses to write when the
  desired state on disk is missing or unparseable instead of
  reconstructing it from process memory.
  The `DISCORD_SUPPRESS_REACTION_EMOJIS` emergency containment (2026-08-03)
  is now a **deprecated compatibility source**: on first materialization of
  the filters file it seeds the key (its one-time migration into the
  plane); an existing filters file without the key keeps using the env
  exactly as shipped — no surprise rewrite; once a file carries the key the
  env is ignored outright — never merged — with a glyph-free warning. The
  env is process-static: it is read once at startup and changing it
  requires a restart (hot reload belongs to the file plane — a running
  process's environment cannot be edited from outside, so no hot-apply is
  claimed for it). Migration: write the key (or let first materialization
  seed it), unset the env, verify `source: "file"`; the alias retires per
  issue #16 once fleet inventory shows migrated files.

### Changed

- **Text attachments now inline into context only up to
  `DISCORD_ATTACHMENT_INLINE_MAX_BYTES` (default 5120 bytes)** — previously
  live delivery inlined text attachments up to 256KiB. Over the cap, the
  agent gets a name+size+URL note instead. The bound is enforced on actual
  received bytes, not Discord's declared attachment size. `0` disables text
  auto-inlining; values clamp to the 262144-byte (256KiB) absolute ceiling;
  malformed or negative values log an error and fall back to the default.
  Raising the cap intentionally restores the prior always-inline behavior.
  Images are unaffected: they inline as native image blocks under their own
  ceilings. (issue #30, PR #12)
