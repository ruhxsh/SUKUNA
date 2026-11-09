import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { fetchAnimeGif } from "../anime-gifs.js";
import { logError, sendBotErrorLog } from "../logging.js";
import {
  requireBotChannelPermission,
  requireTextChannel,
  UserFacingError,
} from "../permissions.js";

const ACTIONS = {
  hug: {
    title: "Hug",
    replyLabel: "Hug back",
    pastTense: "hugged",
    text: (actorId, targetId) => `<@${actorId}> gives <@${targetId}> a warm hug!`,
    needsTarget: true,
  },
  kiss: {
    title: "Kiss",
    replyLabel: "Kiss back",
    pastTense: "kissed",
    text: (actorId, targetId) =>
      `<@${actorId}> gives <@${targetId}> a sweet, cute kiss!`,
    needsTarget: true,
  },
  pat: {
    title: "Pat",
    replyLabel: "Pat back",
    pastTense: "patted",
    text: (actorId, targetId) => `<@${actorId}> gives <@${targetId}> a gentle head pat!`,
    needsTarget: true,
  },
  cuddle: {
    title: "Cuddle",
    replyLabel: "Cuddle back",
    pastTense: "cuddled",
    text: (actorId, targetId) => `<@${actorId}> cuddles up with <@${targetId}>!`,
    needsTarget: true,
  },
  punch: {
    title: "Playful punch",
    replyLabel: "Punch back",
    pastTense: "punched",
    text: (actorId, targetId) =>
      `<@${actorId}> lands a playful anime punch on <@${targetId}>!`,
    needsTarget: true,
  },
  slap: {
    title: "Comedic slap",
    replyLabel: "Slap back",
    pastTense: "slapped",
    text: (actorId, targetId) =>
      `<@${actorId}> gives <@${targetId}> a silly, over-the-top anime slap!`,
    needsTarget: true,
  },
  poke: {
    title: "Poke",
    replyLabel: "Poke back",
    pastTense: "poked",
    text: (actorId, targetId) => `<@${actorId}> pokes <@${targetId}>!`,
    needsTarget: true,
  },
  wave: {
    title: "Wave",
    replyLabel: "Wave back",
    pastTense: "waved",
    text: (actorId, targetId) => `<@${actorId}> waves to <@${targetId}>!`,
    needsTarget: true,
  },
  highfive: {
    title: "High five",
    replyLabel: "High-five back",
    pastTense: "high-fived",
    text: (actorId, targetId) => `<@${actorId}> high-fives <@${targetId}>!`,
    needsTarget: true,
  },
  bite: {
    title: "Playful bite",
    replyLabel: "Bite back",
    pastTense: "bitten",
    text: (actorId, targetId) =>
      `<@${actorId}> gives <@${targetId}> a playful anime bite!`,
    needsTarget: true,
  },
  dance: {
    title: "Dance",
    pastTense: "danced",
    text: (actorId) => `<@${actorId}> breaks into an anime dance!`,
    needsTarget: false,
  },
};

export const ANIME_INTERACTION_COMMANDS = Object.freeze(Object.keys(ACTIONS));
const ANIME_REPLY_TTL_MS = 24 * 60 * 60 * 1_000;

function getTarget(message) {
  const targetMember = message.mentions.members.first();
  if (targetMember) return targetMember;

  if (message.mentions.users.first()) {
    return { invalid: true };
  }
  return null;
}

async function reply(message, content) {
  await message.reply({
    content,
    allowedMentions: { repliedUser: false, parse: [] },
  });
}

function assertAnimeChannel(guild, channel) {
  requireTextChannel(channel);
  requireBotChannelPermission(
    guild,
    channel,
    PermissionFlagsBits.SendMessages,
    "Send Messages",
  );
  requireBotChannelPermission(
    guild,
    channel,
    PermissionFlagsBits.EmbedLinks,
    "Embed Links",
  );
}

function buildCountFooter(actorName, pastTense, targetName, count) {
  const times = count === 1 ? "time" : "times";
  return `${actorName} has ${pastTense} ${targetName} ${count} ${times}.`;
}

function createAnimePayload(actionName, actorId, targetId, image, replyId = null, footerText = null) {
  const action = ACTIONS[actionName];
  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(action.title)
    .setDescription(action.text(actorId, targetId))
    .setImage(image.url);
  if (footerText) embed.setFooter({ text: footerText });

  const payload = {
    embeds: [embed],
    allowedMentions: {
      repliedUser: false,
      parse: [],
      users: targetId ? [actorId, targetId] : [actorId],
    },
  };

  if (replyId && targetId) {
    payload.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`sukuna:anime-reply:${replyId}`)
          .setLabel(action.replyLabel)
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
  }

  return payload;
}

export async function sendAnimeInteractionMessage({
  guild,
  channel,
  command,
  actorId,
  actorName,
  targetId = null,
  targetName = null,
  store,
  gifFetcher = fetchAnimeGif,
  send,
}) {
  const action = ACTIONS[command];
  if (!action) throw new Error("Unknown anime interaction.");
  if (!guild || !channel || !actorId || typeof send !== "function") {
    throw new Error("The anime interaction destination is unavailable.");
  }
  if (action.needsTarget && !targetId) {
    throw new Error("This anime interaction requires a recipient.");
  }

  assertAnimeChannel(guild, channel);
  const image = await gifFetcher(command);
  let replyRecord = null;
  let footerText = null;

  if (targetId) {
    if (!store?.createAnimeReply || !store?.setAnimeReplyMessage) {
      throw new Error("Anime reply buttons are unavailable right now.");
    }
    if (!store?.incrementInteractionCount || !store?.getInteractionCount) {
      throw new Error("Interaction counts are unavailable right now.");
    }
    replyRecord = await store.createAnimeReply({
      guildId: guild.id,
      channelId: channel.id,
      action: command,
      actorId,
      targetId,
      expiresAt: new Date(Date.now() + ANIME_REPLY_TTL_MS).toISOString(),
    });
    const count = await store.incrementInteractionCount(guild.id, actorId, targetId, command);
    footerText = buildCountFooter(actorName, action.pastTense, targetName, count);
  }

  try {
    const sent = await send(
      createAnimePayload(command, actorId, targetId, image, replyRecord?.id ?? null, footerText),
    );
    if (replyRecord && sent?.id) {
      try {
        await store.setAnimeReplyMessage(replyRecord.id, channel.id, sent.id);
      } catch (error) {
        logError(error, "Could not save anime reply message ID");
      }
    }
    return sent;
  } catch (error) {
    if (replyRecord && store.removeAnimeReply) {
      await store.removeAnimeReply?.(replyRecord.id).catch(() => {});
    }
    throw error;
  }
}

export async function handleAnimeInteraction(
  message,
  command,
  client,
  store,
  gifFetcher = fetchAnimeGif,
) {
  const action = ACTIONS[command];
  if (!action) return false;

  let target = null;
  if (action.needsTarget) {
    target = getTarget(message);
    if (!target) {
      await reply(message, `Usage: \`s ${command} @user\` — mention a server member.`);
      return true;
    }
    if (target.invalid) {
      await reply(message, "That person must be a member of this server.");
      return true;
    }
    if (target.id === client.user?.id) {
      await reply(message, "I can't target myself—mention another server member.");
      return true;
    }
    if (target.id === message.author.id) {
      await reply(message, "Mention another member for this interaction.");
      return true;
    }
  }

  const actorName =
    message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? message.author.id;
  const targetName =
    target?.displayName ?? target?.user?.globalName ?? target?.user?.username ?? target?.id ?? null;

  try {
    await sendAnimeInteractionMessage({
      guild: message.guild,
      channel: message.channel,
      command,
      actorId: message.author.id,
      actorName,
      targetId: target?.id ?? null,
      targetName,
      store,
      gifFetcher,
      send: (payload) => message.reply(payload),
    });
  } catch (error) {
    if (error instanceof UserFacingError) {
      await reply(message, error.message);
      return true;
    }
    await sendBotErrorLog(message.guild, store, `Anime interaction: ${command}`, error);
    await reply(
      message,
      "I couldn't load that anime GIF right now. Please try again in a moment.",
    );
    return true;
  }

  return true;
}

async function privateReply(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}

function isReplyContextValid(interaction, record) {
  return Boolean(
    interaction.inGuild?.() &&
      interaction.guildId === record.guildId &&
      interaction.channelId === record.channelId &&
      (!record.messageId || interaction.message?.id === record.messageId),
  );
}

export async function handleAnimeReplyButton(
  interaction,
  store,
  client,
  gifFetcher = fetchAnimeGif,
) {
  const prefix = "sukuna:anime-reply:";
  if (!interaction.customId?.startsWith(prefix)) return false;

  await interaction.deferUpdate();

  const id = interaction.customId.slice(prefix.length);
  const record = store.getAnimeReply(id);
  if (!record) {
    await privateReply(interaction, "This reply button has expired or is no longer available.");
    return true;
  }
  if (interaction.user.id !== record.targetId) {
    await privateReply(interaction, "Only the person who received the interaction can reply.");
    return true;
  }
  if (!isReplyContextValid(interaction, record)) {
    await privateReply(interaction, "This reply button no longer matches its original message.");
    return true;
  }
  if (record.status !== "pending") {
    await privateReply(interaction, "This reply button has already been used or expired.");
    return true;
  }
  if (Date.parse(record.expiresAt) <= Date.now()) {
    await store.consumeAnimeReply(
      id,
      interaction.user.id,
      interaction.guildId,
      interaction.channelId,
      interaction.message?.id,
    );
    await privateReply(interaction, "This reply button has expired.");
    return true;
  }

  const result = await store.consumeAnimeReply(
    id,
    interaction.user.id,
    interaction.guildId,
    interaction.channelId,
    interaction.message?.id,
  );
  if (!result.ok) {
    const messages = {
      unauthorized: "Only the person who received the interaction can reply.",
      expired: "This reply button has expired.",
      resolved: "This reply button has already been used.",
      "wrong-message": "This reply button no longer matches its original message.",
      "not-found": "This reply button is no longer available.",
    };
    await privateReply(interaction, messages[result.reason] ?? "This reply could not be processed.");
    return true;
  }

  try {
    await interaction.editReply({ components: [] });
  } catch (error) {
    logError(error, "Could not disable a used anime reply button");
  }

  const replyActorName =
    interaction.member?.displayName ??
    interaction.user?.globalName ??
    interaction.user?.username ??
    interaction.user.id;
  let originalActorName = result.reply.actorId;
  try {
    const originalMember = await interaction.guild.members.fetch(result.reply.actorId);
    originalActorName =
      originalMember.displayName ??
      originalMember.user?.globalName ??
      originalMember.user?.username ??
      result.reply.actorId;
  } catch {
    // member may have left the guild; fall back to the stored id
  }

  try {
    await sendAnimeInteractionMessage({
      guild: interaction.guild,
      channel: interaction.channel,
      command: result.reply.action,
      actorId: interaction.user.id,
      actorName: replyActorName,
      targetId: result.reply.actorId,
      targetName: originalActorName,
      store,
      gifFetcher,
      send: (payload) => interaction.channel.send(payload),
    });
    await privateReply(interaction, "Your anime interaction was sent.");
  } catch (error) {
    await sendBotErrorLog(
      interaction.guild,
      store,
      `Anime reply interaction: ${result.reply.action}`,
      error,
    );
    await privateReply(
      interaction,
      error instanceof UserFacingError
        ? error.message
        : "I couldn't send that anime reply right now. The button can't be reused, but you can start a new interaction.",
    );
  }

  return true;
}
