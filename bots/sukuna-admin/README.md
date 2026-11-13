# SUKUNA — Administration & Security

Independent Discord bot for server moderation, persistent warnings and moderation history, moderation logs, configurable AutoMod, raid alerts, new-account alerts, suspicious-account review alerts, and audit-log permission anomaly alerts.

## Requirements and setup

- Node.js 22+
- A dedicated Discord application and bot token. Do not reuse another SUKUNA bot's token.
- Persistent host storage; run one process per data directory.
- Enable **Message Content Intent** and **Server Members Intent** in the Developer Portal.
- Bot permissions: View Channels, Send Messages, Embed Links, Manage Messages, Kick Members, Ban Members, Moderate Members, and View Audit Log.
- Do not grant Administrator. Keep the bot role above members it must moderate and below trusted staff roles.
- Set `DISCORD_TOKEN` and `BOT_DATA_DIR` in the host environment. Never commit a token.
- Set the startup directory to `bots/sukuna-admin`, then run `npm install`, `npm run check`, `npm test`, and `npm start`.

## Commands

### Moderation
- `s help`
- `s kick @member [reason]`
- `s ban @member [reason]`
- `s unban USER_ID [reason]`
- `s banlist [page]` (20 bans per page, up to the first 1,000 returned by Discord)
- `s timeout @member 10m [reason]` (1 second–28 days)
- `s untimeout @member [reason]`
- `s warn @member [reason]`
- `s warnings @member` (active warnings only)
- `s warninghistory @member` (active, cleared, and removed warnings)
- `s modhistory @member [page]` (10 records per page; stored moderation actions plus all warning records)
- `s removewarn @member WARNING_NUMBER`
- `s clearwarnings @member`

### Moderation logs
- `s setmodlog #channel`
- `s disablemodlog`
- `s modlog status`

### AutoMod
- `s automod on|off|status`
- `s automod action alert|delete`
- `s automod links on|off`
- `s automod caps on|off`
- `s automod mentions on|off`
- `s automod invites on|off`
- `s automod block add|remove "phrase"`
- `s automod whitelist add|remove "phrase"`
- `s automod limits MAX_MESSAGES INTERVAL_MS DUPLICATE_LIMIT MENTION_LIMIT`
- `s automod ignore channel add|remove #channel`
- `s automod ignore role add|remove @role`

### Raid and security
- `s raid on|off|status`
- `s raid threshold 10 30s` (3–100 joins; 5 seconds–5 minutes)
- `s raid action set alert` (alert-only response is currently supported)
- `s raid whitelist add|remove @member` (Discord IDs are also accepted)
- `s security status`
- `s security suspicious on|off`
- `s security account-age on|off`
- `s security account-age-days 7`

Moderation actions require their matching Discord permission. Ban-list access requires Ban Members; member history and warning views require Moderate Members; server configuration commands require Manage Server. Target hierarchy and bot permissions are checked for sanctions.

Warnings store target ID, moderator ID, reason, timestamp, and a hidden unique record ID. Warnings remain after members leave. Clearing or removing warnings archives them rather than deleting them. Active warning numbering restarts after a clear; archived records remain visible in warning history.

Moderation action history is stored per guild and records manual kick, ban, unban, timeout, untimeout, warning-removal, and warning-clear actions from the release that introduces this feature. Only actual moderation actions are persisted; high-volume AutoMod and security alerts remain in logs without creating history-file writes. Existing warning records are included. Discord does not provide a complete lifetime moderation history, so earlier kicks/bans/timeouts cannot be reconstructed automatically.

## Security behavior

- **AutoMod:** message-rate limits, duplicate messages, mass mentions, optional Discord invite filtering, general link blocking, excessive-uppercase detection, blocked phrases, and a phrase whitelist. Every filter respects configured ignored channels and roles and the selected alert/delete action. A whitelist exempts only its matching blocked phrase; other checks still apply.
- **Raid detection:** counts non-whitelisted joins within the configured window and alerts staff. No automatic punishment or channel lockdown is performed.
- **New-account alerts:** optionally alerts when an account is younger than the configured age threshold.
- **Suspicious-account alerts:** only alerts when two signals occur together: account age is below the configured threshold and the account uses a default avatar. This is a review signal, not proof of abuse.
- **Audit-log anomaly alerts:** alerts when a recorded member kick/ban executor lacks the matching Discord permission. This is not a complete authorization engine and does not undo actions.
- **Moderation logs:** console logging is always active; a configured Discord channel receives embeds when available. `s modlog status` checks the channel and required send/embed permissions.
- New security controls are disabled by default. AutoMod itself is off by default. Raid and suspicious-account detection are opt-in. Raid response is alert-only.

## Storage and reliability

JSON storage is intended for one running process per data directory. Writes and mutations are serialized and written to unique temporary files, synced, then atomically renamed. Existing version 2 warning and configuration data is normalized with defaults for new settings. Back up the data directory before replacing files. Invalid JSON is moved to a timestamped `.corrupt-*` backup instead of being silently overwritten.

## Verification

Run `npm run check` and `npm test`. Tests use temporary directories and do not require a Discord token. Automated tests cannot verify live Discord role hierarchy, intents, permissions, or host persistence; validate those in a private test server before enabling enforcement.
