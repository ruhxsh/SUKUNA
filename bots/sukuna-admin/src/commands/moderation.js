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
  const token = raw || "";
  const mentionId = /^<@!?([0-9]{17,20})>$/.exec(token)?.[1];
  const id = mentionId || token;
  if (!isSnowflake(id)) return null;
  return message.guild.members.fetch(id).catch(() => null);
}

async function execute(message, store, action, targetId, reason, operation, duration = "N/A") {
  try {
    await operation();
    await logModeration(message.client, store, message.guild, { action, targetId, moderatorId: message.author.id, reason, duration, result: "success" });
    await message.reply({ content: "Completed " + action + " for <@" + targetId + ">.", allowedMentions: { parse: [] } });
  } catch (error) {
    await logModeration(message.client, store, message.guild, { action, targetId, moderatorId: message.author.id, reason: reason + " | Error: " + error.message, duration, result: "failed" });
    await message.reply("Could not complete " + action + ": " + error.message.slice(0, 250));
  }
}

export async function handleModerationCommand(message, args, store) {
  const command = (args.shift() || "").toLowerCase();
  const guild = message.guild;
  const member = message.member;
  const botMember = guild.members.me;
  if (!command) return;

  const permission = command === "kick" ? PermissionFlagsBits.KickMembers
    : ["ban", "unban"].includes(command) ? PermissionFlagsBits.BanMembers
    : ["timeout", "untimeout", "warn", "warnings"].includes(command) ? PermissionFlagsBits.ModerateMembers
    : ["setmodlog", "disablemodlog", "clearwarnings", "removewarn", "automod", "raid"].includes(command) ? PermissionFlagsBits.ManageGuild
    : null;

  if (permission && !hasModeratorPermission(member, permission)) {
    await logModeration(message.client, store, guild, { action: command, targetId: args[0] || "N/A", moderatorId: message.author.id, reason: "Permission denied", result: "failed" });
    await message.reply("You do not have permission to use this command.");
    return;
  }

  if (["help", "modhelp"].includes(command)) {
    await message.reply("**SUKUNA — Administration & Security**\n" +
      "s kick @member [reason]\ns ban @member [reason]\ns unban USER_ID [reason]\n" +
      "s timeout @member 10m [reason]\ns untimeout @member [reason]\ns warn @member [reason]\n" +
      "s warnings USER_ID\ns removewarn USER_ID WARNING_ID\ns clearwarnings USER_ID\n" +
      "s setmodlog #channel\ns disablemodlog\ns automod on|off|status\n" +
      "s automod block add|remove \"phrase\"\ns raid on|off|status\ns raid limit 10");
    return;
  }

  if (command === "setmodlog") {
    const channel = message.mentions.channels.first();
    if (!channel?.isTextBased() || !channel.send) return void await message.reply("Mention a text channel: s setmodlog #moderation-logs.");
    await store.updateConfig(guild.id, config => ({ ...config, modLogChannelId: channel.id }));
    await message.reply("Moderation logs will be sent to <#" + channel.id + ">.");
    return;
  }
  if (command === "disablemodlog") {
    await store.updateConfig(guild.id, config => ({ ...config, modLogChannelId: null }));
    await message.reply("Channel logging disabled. Console logging remains enabled.");
    return;
  }

  if (command === "automod") {
    const [sub, ...rest] = args;
    const current = store.getConfig(guild.id).automod;
    if (sub === "status") return void await message.reply("Automod: " + (current.enabled ? "ON" : "OFF") + " | action: " + current.action + " | rate: " + current.maxMessages + "/" + current.intervalMs + "ms | duplicates: " + current.duplicateLimit + " | mention limit: " + current.massMentionLimit + " | blocked phrases: " + current.blockedPhrases.length);
    if (sub === "on" || sub === "off") {
      await store.updateConfig(guild.id, c => ({ ...c, automod: { ...c.automod, enabled: sub === "on" } }));
      return void await message.reply("Automod is now " + sub.toUpperCase() + ". Review settings with s automod status.");
    }
    if (sub === "block" && ["add", "remove"].includes(rest[0])) {
      const phrase = rest.slice(1).join(" ").trim().slice(0, 100);
      if (phrase.length < 2) return void await message.reply('Provide a phrase of at least 2 characters. Example: s automod block add "example phrase".');
      await store.updateConfig(guild.id, c => {
        const list = c.automod.blockedPhrases;
        const exists = list.some(p => p.toLowerCase() === phrase.toLowerCase());
        const next = rest[0] === "add" ? (exists ? list : [...list, phrase]) : list.filter(p => p.toLowerCase() !== phrase.toLowerCase());
        return { ...c, automod: { ...c.automod, blockedPhrases: next } };
      });
      return void await message.reply("Blocked phrase list updated.");
    }
    if (sub === "action" && ["alert", "delete"].includes(rest[0])) {
      await store.updateConfig(guild.id, c => ({ ...c, automod: { ...c.automod, action: rest[0] } }));
      return void await message.reply("Automod action set to " + rest[0] + ".");
    }
    if (sub === "limits") {
      const [rate, interval, duplicates, mentions] = rest.map(Number);
      if (![rate, interval, duplicates, mentions].every(Number.isInteger)) return void await message.reply("Usage: s automod limits MAX_MESSAGES INTERVAL_MS DUPLICATE_LIMIT MENTION_LIMIT");
      if (rate < 3 || rate > 30 || interval < 3000 || interval > 60000 || duplicates < 2 || duplicates > 10 || mentions < 2 || mentions > 50) return void await message.reply("Limits: messages 3–30, interval 3000–60000ms, duplicates 2–10, mentions 2–50.");
      await store.updateConfig(guild.id, c => ({ ...c, automod: { ...c.automod, maxMessages: rate, intervalMs: interval, duplicateLimit: duplicates, massMentionLimit: mentions } }));
      return void await message.reply("Automod thresholds updated.");
    }
    return void await message.reply("Use s automod on|off|status, s automod action alert|delete, s automod block add|remove phrase, or s automod limits MAX_MESSAGES INTERVAL_MS DUPLICATE_LIMIT MENTION_LIMIT.");
  }

  if (command === "raid") {
    const [sub, value] = args;
    const current = store.getConfig(guild.id).security;
    if (sub === "status") return void await message.reply("Raid protection: " + (current.raidProtectionEnabled ? "ON" : "OFF") + " | alert threshold: " + current.raidJoinLimit + " joins / " + current.raidWindowMs + "ms. Detection only; no automatic punishment.");
    if (sub === "on" || sub === "off") {
      await store.updateConfig(guild.id, c => ({ ...c, security: { ...c.security, raidProtectionEnabled: sub === "on" } }));
      return void await message.reply("Raid detection is now " + sub.toUpperCase() + ". It only alerts; it does not punish members.");
    }
    if (sub === "limit") {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 3 || limit > 100) return void await message.reply("Use a join threshold from 3 to 100.");
      await store.updateConfig(guild.id, c => ({ ...c, security: { ...c.security, raidJoinLimit: limit } }));
      return void await message.reply("Raid alert threshold set to " + limit + " joins.");
    }
    return void await message.reply("Use s raid on|off|status or s raid limit 10.");
  }

  if (command === "unban") {
    const id = args[0];
    if (!isSnowflake(id)) return void await message.reply("Usage: s unban USER_ID [reason].");
    await execute(message, store, command, id, reasonFrom(args, 1), () => guild.members.unban(id, reasonFrom(args, 1)));
    return;
  }

  const known = ["kick", "ban", "timeout", "untimeout", "warn", "warnings", "removewarn", "clearwarnings"];
  if (!known.includes(command)) return void await message.reply("Unknown command. Use s help.");

  const targetToken = args[0];
  const mentionId = /^<@!?(\d{17,20})>$/.exec(targetToken || "")?.[1];
  const targetId = mentionId || targetToken;
  if (!isSnowflake(targetId)) return void await message.reply("Target not found. Mention a member or provide their Discord ID.");
  if (["warnings", "removewarn", "clearwarnings"].includes(command)) {
    if (command === "warnings") {
      const records = store.getWarnings(guild.id, targetId);
      if (!records.length) return void await message.reply("That user has no warnings on record.");
      const embed = new EmbedBuilder().setTitle("Warnings for " + targetId).setDescription(records.slice(0, 12).map(w =>
        "ID: " + w.id + "\nReason: " + w.reason + "\nModerator: <@" + w.moderatorId + ">\nDate: " + w.createdAt
      ).join("\n\n").slice(0, 4000));
      return void await message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    if (command === "clearwarnings") {
      const count = await store.clearWarnings(guild.id, targetId);
      await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason: "Cleared " + count + " warning(s)", result: "success" });
      return void await message.reply("Cleared " + count + " warning(s) for " + targetId + ".");
    }
    const warningId = args[1];
    if (!warningId) return void await message.reply("Usage: s removewarn USER_ID WARNING_ID.");
    const removed = await store.removeWarning(guild.id, targetId, warningId);
    if (!removed) return void await message.reply("Warning record not found for that user.");
    await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason: "Removed warning " + warningId, result: "success" });
    return void await message.reply("Removed warning " + warningId + ".");
  }

  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target) return void await message.reply("That member is not currently in this server. Warning history can still be viewed by ID.");
  const reason = reasonFrom(args, command === "timeout" ? 2 : 1);
  if (command === "warn") {
    const roleError = target.id === message.author.id || target.id === guild.ownerId || (message.author.id !== guild.ownerId && member.roles.highest.comparePositionTo(target.roles.highest) <= 0);
    if (roleError) return void await message.reply("You cannot warn yourself, the server owner, or a member with an equal or higher role.");
    const record = await store.addWarning({ guildId: guild.id, targetId, moderatorId: message.author.id, reason });
    await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason, result: "success" });
    return void await message.reply("Warning recorded for <@" + targetId + ">. Record ID: " + record.id);
  }

  const safetyError = canActOnTarget(member, target, botMember, command === "untimeout" ? "timeout" : command);
  if (safetyError) {
    await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason: reason + " | " + safetyError, result: "failed" });
    return void await message.reply(safetyError);
  }
  if (command === "kick") await execute(message, store, command, targetId, reason, () => target.kick(reason));
  else if (command === "ban") await execute(message, store, command, targetId, reason, () => target.ban({ reason }));
  else if (command === "timeout") {
    const duration = parseDuration(args[1]);
    if (!duration) return void await message.reply("Use 1s–28d, for example 10m, 2h, or 1d.");
    await execute(message, store, command, targetId, reason, () => target.timeout(duration, reason), args[1]);
  } else if (command === "untimeout") await execute(message, store, command, targetId, reason, () => target.timeout(null, reason));
}
