import { Client, Events, GatewayIntentBits } from "discord.js";
import { handleCountingCommand, handleCountingMessage } from "./counting.js";
import { CountingStore } from "./store.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error("DISCORD_TOKEN is missing. Set it as a private environment variable.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const store = await CountingStore.fromEnvironment().load();

client.once(Events.ClientReady, (readyClient) => {
  console.info(
    `[SUKUNA GAMING] Counting system online as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} server(s).`,
  );
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot || !message.guild) return;

    if (await handleCountingCommand(message, store)) return;
    await handleCountingMessage(message, store);
  } catch (error) {
    console.error("[SUKUNA GAMING] Message handler failed.", error);
  }
});

client.on(Events.Error, (error) => {
  console.error("[SUKUNA GAMING] Discord client error.", error);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[SUKUNA GAMING] Received ${signal}; shutting down.`);

  try {
    await store.flush();
  } finally {
    client.destroy();
    process.exit(0);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (error) => {
  console.error("[SUKUNA GAMING] Unhandled promise rejection.", error);
});

await client.login(token);
