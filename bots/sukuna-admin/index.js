import { Client, GatewayIntentBits, Partials } from "discord.js";
import { PREFIX, getDataFilePath } from "./src/config.js";
import { JsonStore } from "./src/store.js";
import { handleModerationCommand } from "./src/commands/moderation.js";
import { cacheMessage, handleDeletedMessage } from "./src/deleted-messages.js";
import { handleAutomodMessage, handleRaidJoin, handleAuditLogEntry } from "./src/security.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN environment variable. Add the bot token in your host's environment settings.");
  process.exit(1);
}

const client = new Client({
  partials: [Partials.Message, Partials.Channel],
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const store = await new JsonStore(getDataFilePath()).init();

client.once("ready", readyClient => {
  console.log("Logged in as " + readyClient.user.tag);
  console.log("SUKUNA — Administration & Security is online. Prefix: " + PREFIX);
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;
  try {
    cacheMessage(message);
    if (await handleAutomodMessage(message, store)) return;
    const content = message.content.trim();
    if (content.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return;
    if (content.length > PREFIX.length && !/\s/.test(content[PREFIX.length])) return;
    const remainder = content.slice(PREFIX.length).trim();
    if (!remainder) return;
    const args = remainder.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    for (let i = 0; i < args.length; i++) args[i] = args[i].replace(/^["']|["']$/g, "");
    await handleModerationCommand(message, args, store);
  } catch (error) {
    console.error("Message processing failed:", error);
    if (message.channel?.send) await message.reply("An unexpected error occurred while processing that message.").catch(() => {});
  }
});

client.on("messageUpdate", async (_oldMessage, newMessage) => {
  try { cacheMessage(newMessage); }
  catch (error) { console.error("Could not refresh deleted-message cache:", error); }
});

client.on("messageDelete", async message => {
  try { await handleDeletedMessage(message, store); }
  catch (error) { console.error("Deleted-message logging failed:", error); }
});

client.on("guildMemberAdd", async member => {
  try { await handleRaidJoin(member, store); }
  catch (error) { console.error("Join security check failed:", error); }
});

client.on("guildAuditLogEntryCreate", async (entry, guild) => {
  try { await handleAuditLogEntry(entry, guild, store, client); }
  catch (error) { console.error("Audit-log security check failed:", error); }
});

client.on("error", error => console.error("Discord client error:", error));
process.on("unhandledRejection", error => console.error("Unhandled rejection:", error));
process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});
await client.login(token);
