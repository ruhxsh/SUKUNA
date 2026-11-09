
import { MessageFlags } from "discord.js";
import { sendBotErrorLog, logError } from "./logging.js";
import { UserFacingError } from "./permissions.js";
import { handleModeration } from "./commands/moderation.js";
import { handleSecurity } from "./commands/security.js";
import {
  handleAnimeInteraction,
  handleAnimeReplyButton,
} from "./commands/anime-interactions.js";
import {
  handleMarriageButton,
  handleMarriageCommand,
} from "./commands/marriage.js";
import { handleRoleButton, handleRoleManagement } from "./commands/roles.js";
import { handleHelpInteraction, handleUtility } from "./commands/utility.js";
import { handleCountingMessage } from "./commands/counting.js";
import { handleAutoModeration } from "./automod.js";
import {
  handleCommunityCommand,
  handleCommunityInteraction,
  handleCommunityMessage,
} from "./commands/community.js";

const COMMAND_PREFIX = "s";

export function parseCommand(content) {
  const match = /^[sS](?:\s+([\s\S]*))?$/.exec(content ?? "");
  if (!match) return null;

  const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);

  return {
    command: words.shift()?.toLowerCase() ?? "",
    args: words,
  };
}

async function replySafely(message, content) {
  try {
    await message.reply({
      content,
      allowedMentions: { repliedUser: false, parse: [] },
    });
  } catch (error) {
    logError(error, "Could not reply to a server command");
  }
}

export async function handleMessage(message, client, store) {
  if (message.author?.bot || !message.guild) return;

  const channelId = message.channelId;
  if (
    channelId &&
    client?.channels?.fetch &&
    !client.channels.cache?.has(channelId)
  ) {
    const channel = await client.channels.fetch(channelId).catch((error) => {
      logError(error, "Could not fetch the channel for an incoming server message");
      return null;
    });
    if (!channel) return;
  }

  // Process AFK notifications separately so they do not delay commands.
  void handleCommunityMessage(message, store).catch((error) => {
    logError(error, "Community message handler");
  });

  const parsed = parseCommand(message.content);

  if (!parsed) {
    try {
      const moderated = await handleAutoModeration(message, store);
      if (moderated) return;
    } catch (error) {
      await sendBotErrorLog(
        message.guild,
        store,
        "Automatic moderation",
        error,
      );
    }

    await handleCountingMessage(message, store);
    return;
  }

  if (!parsed.command) {
    await replySafely(
      message,
      "Use `s help` to see the available commands.",
    );
    return;
  }

  try {
    const handled =
      (await handleCommunityCommand(message, parsed.command, parsed.args, store)) ||
      (await handleSecurity(message, parsed.command, parsed.args, store)) ||
      (await handleModeration(message, parsed.command, parsed.args, store)) ||
      (await handleRoleManagement(message, parsed.command, store)) ||
      (await handleUtility(message, parsed.command, parsed.args, client)) ||
      (await handleMarriageCommand(message, parsed.command, store)) ||
      (await handleAnimeInteraction(
        message,
        parsed.command,
        client,
        store,
      ));

    if (!handled) {
      await replySafely(
        message,
        "Unknown command. Use `s help` to see the command list.",
      );
    }
  } catch (error) {
    if (error instanceof UserFacingError) {
      await replySafely(message, error.message);
      return;
    }

    await sendBotErrorLog(
      message.guild,
      store,
      `Command ${parsed.command}`,
      error,
    );

    await replySafely(
      message,
      "That command could not be completed. Please try again later.",
    );
  }
}

export async function handleInteraction(interaction, store, client) {
  if (!interaction.isButton()) return;

  try {
    await handleHelpInteraction(interaction) ||
      await handleCommunityInteraction(interaction, store) ||
      await handleRoleButton(interaction, store) ||
      await handleAnimeReplyButton(interaction, store, client) ||
      await handleMarriageButton(interaction, store);
  } catch (error) {
    await sendBotErrorLog(
      interaction.guild,
      store,
      "Button interaction",
      error,
    );

    const response = {
      content: "That action could not be completed. Try again later.",
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
}

export async function handleVoiceStateUpdate(oldState, newState, store) {
  const { handleCommunityVoiceState } = await import("./commands/community.js");
  await handleCommunityVoiceState(oldState, newState, store);
}

export { COMMAND_PREFIX };
