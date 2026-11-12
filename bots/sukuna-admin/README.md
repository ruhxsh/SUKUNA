# SUKUNA — Administration & Security

Standalone Discord moderation bot. This bot owns moderation, warning records, moderation logs, automod, and server security. Other SUKUNA bots must not duplicate those responsibilities.

## Requirements
- Node.js 22+
- A Discord application and bot user
- A host with persistent storage for the data directory

## Setup
1. In the Discord Developer Portal, create an application named SUKUNA, or use the existing application if it is dedicated to this bot.
2. Open Bot and create/reset the bot token. Keep it private.
3. Under Privileged Gateway Intents, enable Message Content Intent and Server Members Intent.
4. In OAuth2 URL Generator, select the bot scope and these permissions: View Channels, Send Messages, Embed Links, Read Message History, Kick Members, Ban Members, and Moderate Members. Do not grant Administrator.
5. On the host, set environment variable DISCORD_TOKEN to the bot token. Never put the token in code or GitHub.
6. Set the startup directory to bots/sukuna-admin, run npm install, then npm start.
7. Set BOT_DATA_DIR to the host's persistent data directory. Without persistent storage, warnings may be lost on restart.

## Commands
Prefix: s (uppercase S also works).
- s help
- s kick @member [reason]
- s ban @member [reason]
- s unban USER_ID [reason]
- s timeout @member 10m [reason]
- s untimeout @member [reason]
- s warn @member [reason]
- s warnings @member
- s removewarn @member WARNING_ID
- s clearwarnings @member
- s setmodlog #channel
- s disablemodlog

Timeout units: s, m, h, d. Maximum duration: 28 days.

## Tests
Run npm test. Tests use temporary files and do not need a Discord token.

## Current scope
This first release implements manual moderation, persistent warning records, and moderation logs. Automod and raid protection are not yet active; they will be added in a later tested phase. Keep backups of the persistent data directory.
