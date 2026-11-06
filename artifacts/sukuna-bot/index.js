import { Client, Events, GatewayIntentBits } from "discord.js";
import { handleInteraction, handleMessage, handleVoiceStateUpdate } from "./src/command-handler.js";
import { assignAutorole, logError, sendWelcomeMessage } from "./src/logging.js";
import { JsonStore } from "./src/store.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

async function start() {
  if (!process.env.DISCORD_TOKEN) {
    throw new Error("DISCORD_TOKEN is missing. Set it in your host's environment variables.");
  }

  const store = await JsonStore.fromEnvironment().load();

  client.once(Events.ClientReady, (readyClient) => {
    console.info(
      `[Sukuna] Logged in as ${readyClient.user.tag}; connected to ${readyClient.guilds.cache.size} server(s).`,
    );
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message, client, store);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, store, client);
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    void handleVoiceStateUpdate(oldState, newState, store);
  });

  client.on(Events.MessageDelete, (message) => {
    void store.cancelInteractionsForMessage(message.channelId, message.id)
      .catch((error) => logError(error, "Could not cancel buttons for a deleted message"));
  });

  client.on("messageDeleteBulk", (messages) => {
    void Promise.all(
      [...messages.values()].map((message) =>
        store.cancelInteractionsForMessage(message.channelId, message.id),
      ),
    ).catch((error) => logError(error, "Could not cancel buttons for deleted messages"));
  });

  client.on(Events.GuildMemberAdd, (member) => {
    void sendWelcomeMessage(member, store);
    void assignAutorole(member, store);
  });

  client.on(Events.Error, (error) => logError(error, "Discord client error"));

  await client.login(process.env.DISCORD_TOKEN);
}

process.on("unhandledRejection", (error) => logError(error, "Unhandled promise rejection"));
process.on("uncaughtException", (error) => {
  logError(error, "Uncaught exception; stopping the bot");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.info(`[Sukuna] Received ${signal}; shutting down.`);
    client.destroy();
    process.exit(0);
  });
}

start().catch((error) => {
  logError(error, "Startup failed. Check the token, enabled Discord intents, and data file.");
  process.exitCode = 1;
});
