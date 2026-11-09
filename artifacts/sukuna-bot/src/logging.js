import { EmbedBuilder } from "discord.js";

function safeErrorCode(error) {
  const code = error?.code ?? error?.name ?? "UnknownError";
  return String(code).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 60) || "UnknownError";
}

export function safeErrorMessage(error, token = process.env.DISCORD_TOKEN) {
  let message = typeof error?.message === "string" ? error.message : "No additional details";
  if (token) message = message.split(token).join("[REDACTED]");

  return message
    .replace(
      /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,})\b/g,
      "[REDACTED]",
    )
    .replace(/\b(?:Bearer|Bot)\s+[A-Za-z0-9._-]{20,}/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

export function logError(error, context) {
  console.error(
    `[Sukuna] ${context} (${safeErrorCode(error)}): ${safeErrorMessage(error)}`,
  );
}

async function getLogChannel(guild, store) {
  const channelId = store.getGuildConfig(guild.id).modLogChannelId;
  if (!channelId) return null;

  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isTextBased?.() || !channel.send) return null;
  return channel;
}

export async function sendModerationLog({
  guild,
  store,
  action,
  moderator,
  target,
  reason,
}) {
  try {
    const channel = await getLogChannel(guild, store);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x9f1239)
      .setTitle(`Moderation action: ${action}`)
      .addFields(
        { name: "Moderator", value: `${moderator.tag} (${moderator.id})` },
        { name: "Target", value: `${target.tag} (${target.id})` },
        { name: "Reason", value: String(reason || "No reason provided.").slice(0, 1024) },
      )
      .setTimestamp();

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    logError(error, "Could not send a moderation log");
  }
}

export async function sendBotErrorLog(guild, store, context, error) {
  logError(error, context);
  if (!guild) return;

  try {
    const channel = await getLogChannel(guild, store);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle("Bot error")
      .setDescription(
        `**Where:** ${String(context).slice(0, 200)}\n**Error code:** ${safeErrorCode(error)}`,
      )
      .setTimestamp();

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (logErrorValue) {
    logError(logErrorValue, "Could not write an error to the configured log channel");
  }
}

export async function sendWelcomeMessage(member, store) {
  const channelId = store.getGuildConfig(member.guild.id).welcomeChannelId;
  if (!channelId) return;

  try {
    const channel = await member.guild.channels.fetch(channelId);
    if (!channel?.isTextBased?.() || !channel.send) {
      throw new Error("Configured welcome channel is not a text channel.");
    }

    await channel.send({
      content: `Welcome to **${member.guild.name}**, <@${member.id}>!`,
      allowedMentions: { users: [member.id] },
    });
  } catch (error) {
    await sendBotErrorLog(member.guild, store, "Welcome message", error);
  }
}

const reportedAutoroleProblems = new Set();

export async function assignAutorole(member, store) {
  const roleId = store.getGuildConfig(member.guild.id).autoRoleId;
  if (!roleId) return;

  const problemKey = member.guild.id + ":" + roleId;
  try {
    const role = await member.guild.roles.fetch(roleId);
    if (!role) throw new Error("Configured autorole no longer exists.");

    const botMember =
      member.guild.members.me ??
      (await member.guild.members.fetchMe().catch(() => null));

    if (!botMember?.permissions.has("ManageRoles")) {
      throw new Error("Sukuna needs the Manage Roles permission.");
    }
    if (role.managed) {
      throw new Error("The configured autorole is integration-managed and cannot be assigned.");
    }
    if (role.comparePositionTo(botMember.roles.highest) >= 0) {
      throw new Error(
        "Move Sukuna's bot role above the configured autorole in Server Settings > Roles, then run s setautorole @role again.",
      );
    }

    await member.roles.add(role, "Sukuna automatic member role");
    reportedAutoroleProblems.delete(problemKey);
  } catch (error) {
    if (!reportedAutoroleProblems.has(problemKey)) {
      reportedAutoroleProblems.add(problemKey);
      await sendBotErrorLog(member.guild, store, "Autorole assignment", error);
    }
  }
}

