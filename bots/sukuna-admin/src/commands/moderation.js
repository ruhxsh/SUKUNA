import { PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { canActOnTarget, hasModeratorPermission, isSnowflake } from "../permissions.js";
import { logModeration } from "../logger.js";

const DEFAULT_REASON = "No reason supplied";
const reasonFrom = (args, start = 1) => args.slice(start).join(" ").trim().slice(0, 500) || DEFAULT_REASON;
const parseDuration = input => {
  const match = /^(\d+)([smhd])$/i.exec(input || "");
  if (!match) return null;
  const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2].toLowerCase()];
  const ms = Number(match[1]) * multiplier;
  return Number.isSafeInteger(ms) && ms >= 1000 && ms <= 28 * 86400000 ? ms : null;
};

async function resolveTarget(message, raw) {
  const mentioned = message.mentions.members.first();
  if (mentioned) return mentioned;
  const id = raw?.replace(/[<@!>]/g, "");
  if (!isSnowflake(id)) return null;
  return message.guild.members.fetch(id).catch(() => null);
}

async function execute(message, store, action, targetId, reason, operation, duration = "N/A") {
  try {
    await operation();
    await logModeration(message.client, store, message.guild, {
      action, targetId, moderatorId: message.author.id, reason, duration, result: "success"
    });
    await message.reply("Completed " + action + " for <@" + targetId + ">.");
  } catch (error) {
    await logModeration(message.client, store, message.guild, {
      action, targetId, moderatorId: message.author.id,
      reason: reason + " | Error: " + error.message, duration, result: "failed"
    });
    await message.reply("Could not complete " + action + ": " + error.message.slice(0, 250));
  }
}

export async function handleModerationCommand(message, args, store) {
  const command = (args.shift() || "").toLowerCase();
  const guild = message.guild;
  const member = message.member;
  const botMember = guild.members.me;
  if (!command) return;

  const permission = command === "kick"
    ? PermissionFlagsBits.KickMembers
    : ["ban", "unban"].includes(command)
      ? PermissionFlagsBits.BanMembers
      : ["timeout", "untimeout", "warn", "warnings"].includes(command)
        ? PermissionFlagsBits.ModerateMembers
        : ["setmodlog", "disablemodlog", "clearwarnings", "removewarn"].includes(command)
          ? PermissionFlagsBits.ManageGuild
          : null;

  if (permission && !hasModeratorPermission(member, permission)) {
    await logModeration(message.client, store, guild, {
      action: command, targetId: args[0] || "N/A", moderatorId: message.author.id,
      reason: "Permission denied", result: "failed"
    });
    await message.reply("You do not have permission to use this command.");
    return;
  }

  if (["help", "modhelp"].includes(command)) {
    await message.reply("**SUKUNA — Administration & Security**\n" +
      "s kick @member [reason]\ns ban @member [reason]\ns unban USER_ID [reason]\n" +
      "s timeout @member 10m [reason]\ns untimeout @member [reason]\n" +
      "s warn @member [reason]\ns warnings @member\ns removewarn @member WARNING_ID\n" +
      "s clearwarnings @member\ns setmodlog #channel\ns disablemodlog");
    return;
  }

  if (command === "setmodlog") {
    const channel = message.mentions.channels.first();
    if (!channel?.isTextBased() || !channel.send) {
      await message.reply("Mention a text channel: s setmodlog #moderation-logs.");
      return;
    }
    await store.updateConfig(guild.id, config => ({ ...config, modLogChannelId: channel.id }));
    await message.reply("Moderation logs will be sent to <#" + channel.id + ">.");
    return;
  }
  if (command === "disablemodlog") {
    await store.updateConfig(guild.id, config => ({ ...config, modLogChannelId: null }));
    await message.reply("Channel logging disabled. Console logging remains enabled.");
    return;
  }
  if (command === "unban") {
    const id = args[0];
    if (!isSnowflake(id)) {
      await message.reply("Usage: s unban USER_ID [reason].");
      return;
    }
    await execute(message, store, command, id, reasonFrom(args, 1),
      () => guild.members.unban(id, reasonFrom(args, 1)));
    return;
  }

  const known = ["kick", "ban", "timeout", "untimeout", "warn", "warnings", "removewarn", "clearwarnings"];
  if (!known.includes(command)) {
    await message.reply("Unknown command. Use s help.");
    return;
  }

  const target = await resolveTarget(message, args[0]);
  if (!target) {
    await message.reply("Target member not found. Mention a member or provide their ID.");
    return;
  }

  if (command === "warnings") {
    const records = store.getWarnings(guild.id, target.id);
    if (!records.length) {
      await message.reply("<@" + target.id + "> has no warnings.");
      return;
    }
    const embed = new EmbedBuilder().setTitle("Warnings for " + target.user.tag)
      .setDescription(records.slice(0, 12).map(w =>
        "ID: " + w.id + "\nReason: " + w.reason + "\nModerator: <@" + w.moderatorId + ">\nDate: " + w.createdAt
      ).join("\n\n").slice(0, 4000));
    await message.reply({ embeds: [embed] });
    return;
  }

  if (command === "warn") {
    const reason = reasonFrom(args);
    const record = await store.addWarning({
      guildId: guild.id, targetId: target.id, moderatorId: message.author.id, reason
    });
    await logModeration(message.client, store, guild, {
      action: command, targetId: target.id, moderatorId: message.author.id, reason, result: "success"
    });
    await message.reply("Warning recorded for <@" + target.id + ">. Record ID: " + record.id);
    return;
  }

  if (command === "clearwarnings") {
    const count = await store.clearWarnings(guild.id, target.id);
    await logModeration(message.client, store, guild, {
      action: command, targetId: target.id, moderatorId: message.author.id,
      reason: "Cleared " + count + " warning(s)", result: "success"
    });
    await message.reply("Cleared " + count + " warning(s) for <@" + target.id + ">.");
    return;
  }

  if (command === "removewarn") {
    const warningId = args[1];
    if (!warningId) {
      await message.reply("Usage: s removewarn @member WARNING_ID.");
      return;
    }
    const removed = await store.removeWarning(guild.id, target.id, warningId);
    if (!removed) {
      await message.reply("Warning record not found for that member.");
      return;
    }
    await logModeration(message.client, store, guild, {
      action: command, targetId: target.id, moderatorId: message.author.id,
      reason: "Removed warning " + warningId, result: "success"
    });
    await message.reply("Removed warning " + warningId + " from <@" + target.id + ">.");
    return;
  }

  const reason = reasonFrom(args, command === "timeout" ? 2 : 1);
  const safetyError = canActOnTarget(member, target, botMember, command === "untimeout" ? "timeout" : command);
  if (safetyError) {
    await logModeration(message.client, store, guild, {
      action: command, targetId: target.id, moderatorId: message.author.id,
      reason: reason + " | " + safetyError, result: "failed"
    });
    await message.reply(safetyError);
    return;
  }

  if (command === "kick") {
    await execute(message, store, command, target.id, reason, () => target.kick(reason));
  } else if (command === "ban") {
    await execute(message, store, command, target.id, reason, () => target.ban({ reason }));
  } else if (command === "timeout") {
    const duration = parseDuration(args[1]);
    if (!duration) {
      await message.reply("Use 1s–28d, for example 10m, 2h, or 1d.");
      return;
    }
    await execute(message, store, command, target.id, reason, () => target.timeout(duration, reason), args[1]);
  } else if (command === "untimeout") {
    await execute(message, store, command, target.id, reason, () => target.timeout(null, reason));
  }
}
