import { Client, GatewayIntentBits } from "discord.js";
import { PREFIX, getDataFilePath } from "./src/config.js";
import { JsonStore } from "./src/store.js";
import { handleModerationCommand } from "./src/commands/moderation.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN environment variable. Add the bot token in your host's environment settings.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
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
  const content = message.content.trim();
  if (content.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return;
  const remainder = content.slice(PREFIX.length).trim();
  if (!remainder) return;
  const args = remainder.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (let i = 0; i < args.length; i++) args[i] = args[i].replace(/^["']|["']$/g, "");
  try {
    await handleModerationCommand(message, args, store);
  } catch (error) {
    console.error("Command failed:", error);
    await message.reply("An unexpected error occurred while processing that command.").catch(() => {});
  }
});

client.on("error", error => console.error("Discord client error:", error));
process.on("unhandledRejection", error => console.error("Unhandled rejection:", error));
process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

await client.login(token);
