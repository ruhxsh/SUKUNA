import { PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { canActOnTarget, hasModeratorPermission, isSnowflake } from "../permissions.js";
import { logModeration } from "../logger.js";

const DEFAULT_REASON = "No reason supplied";
const userMention = id => isSnowflake(id) ? "<@" + id + ">" : "Unknown member";
async function getUserMention(guild, id) {
  if (!isSnowflake(id)) return "Unknown member";
  const member = await guild.members.fetch(id).catch(() => null);
  if (member) return "<@" + member.id + ">";
  const user = await guild.client.users.fetch(id).catch(() => null);
  return user ? "<@" + user.id + ">" : "<@" + id + ">";
}
const reasonFrom = (args, start = 1) => args.slice(start).join(" ").trim().slice(0, 500) || DEFAULT_REASON;
const mentionIdFrom = token => /^<@!?(\\d{17,20})>$/.exec(token || "")?.[1] || (isSnowflake(token) ? token : null);
function parseWindow(value) {
  const match = /^(\\d+)(s|m)$/i.exec(value || "");
  if (!match) return null;
  const ms = Number(match[1]) * (match[2].toLowerCase() === "s" ? 1000 : 60000);
  return Number.isSafeInteger(ms) && ms >= 5000 && ms <= 300000 ? ms : null;
}
async function logConfigChange(message, store, reason) {
  await logModeration(message.client, store, message.guild, {
    action: "security-config", targetId: message.author.id, moderatorId: message.author.id,
    reason, result: "success"
  });
}
const parseDuration = input => {
  const match = /^(\d+)([smhd])$/i.exec(input || "");
  if (!match) return null;
  const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2].toLowerCase()];
  const ms = Number(match[1]) * multiplier;
  return Number.isSafeInteger(ms) && ms >= 1000 && ms <= 28 * 86400000 ? ms : null;
};

async function execute(message, store, action, targetId, reason, operation, duration = "N/A") {
  try {
    await operation();
  } catch (error) {
    await logModeration(message.client, store, message.guild, { action, targetId, moderatorId: message.author.id, reason: reason + " | Error: " + error.message, duration, result: "failed" });
    await message.reply("Could not complete " + action + ": " + error.message.slice(0, 250)).catch(() => {});
    return;
  }
  await logModeration(message.client, store, message.guild, { action, targetId, moderatorId: message.author.id, reason, duration, result: "success" });
  await message.reply({ content: "Completed " + action + " for " + userMention(targetId) + ".", allowedMentions: { users: [targetId] } }).catch(error => {
    console.warn("Moderation action succeeded, but confirmation could not be sent:", error.message);
  });
}

export async function handleModerationCommand(message, args, store) {
  const command = (args.shift() || "").toLowerCase();
  const guild = message.guild;
  const member = message.member;
  const botMember = guild.members.me;
  if (!command) return;

  const permission = command === "kick" ? PermissionFlagsBits.KickMembers
    : ["ban", "unban", "banlist"].includes(command) ? PermissionFlagsBits.BanMembers
    : ["timeout", "untimeout", "warn", "warnings", "warninghistory", "modhistory"].includes(command) ? PermissionFlagsBits.ModerateMembers
    : ["setmodlog", "disablemodlog", "modlog", "clearwarnings", "removewarn", "automod", "raid", "security"].includes(command) ? PermissionFlagsBits.ManageGuild
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
      "s warnings @member\ns warninghistory @member\ns modhistory @member\ns removewarn @member WARNING_NUMBER\ns clearwarnings @member\n" +
      "s banlist\ns setmodlog #channel\ns disablemodlog\ns modlog status\n" +
      "s automod on|off|status\ns automod links|caps|mentions on|off\ns automod whitelist add|remove phrase\n" +
      "s automod block add|remove \"phrase\"\ns automod invites on|off\ns automod limits MAX INTERVAL DUPLICATES MENTIONS\ns automod ignore channel|role add|remove\n" +
      "s raid on|off|status\ns raid threshold 10 30s\ns raid action set alert\ns raid whitelist add|remove @member\n" +
      "s security status\ns security suspicious on|off\ns security account-age on|off\ns security account-age-days 7");
    return;
  }

  if (command === "setmodlog") {
    const channel = message.mentions.channels.first();
    if (!channel?.isTextBased() || !channel.send || channel.guild?.id !== guild.id) return void await message.reply("Mention a text channel in this server: s setmodlog #moderation-logs.");
    const channelPermissions = channel.permissionsFor(botMember);
    if (!channelPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return void await message.reply("I need View Channel, Send Messages, and Embed Links in that channel before it can be used for moderation logs.");
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

  if (command === "modlog" && args[0]?.toLowerCase() === "status") {
    const channelId = store.getConfig(guild.id).modLogChannelId;
    if (!channelId) return void await message.reply("Moderation logging is DISABLED. No destination channel is configured.");
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return void await message.reply("Moderation logging is configured, but its channel is missing or is not a text channel: <#" + channelId + ">.");
    const permissions = channel.permissionsFor(botMember);
    const ready = permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    return void await message.reply("Moderation logging is CONFIGURED for <#" + channelId + "> and is " + (ready ? "READY" : "NOT READY") + ". " + (ready ? "The bot can view the channel, send messages, and embed logs." : "Check View Channel, Send Messages, and Embed Links permissions."));
  }

  if (command === "banlist") {
    try {
      const bans = await guild.bans.fetch({ limit: 1000 });
      if (!bans.size) return void await message.reply("There are no banned users in this server.");
      const lines = [...bans.values()].slice(0, 20).map(ban =>
        "**" + ban.user.username + "** (`" + ban.user.id + "`) — " + String(ban.reason || "No reason recorded").slice(0, 100)
      );
      return void await message.reply("**Server ban list** — " + bans.size + " record(s) fetched. Showing up to 20:\n" + lines.join("\n").slice(0, 1700));
    } catch (error) {
      return void await message.reply("Could not fetch the ban list. Check that I have the Ban Members permission.");
    }
  }

  if (command === "automod") {
    const [sub, ...rest] = args;
    const current = store.getConfig(guild.id).automod;
    if (sub === "status") return void await message.reply("Automod: " + (current.enabled ? "ON" : "OFF") + " | action: " + current.action + " | rate: " + current.maxMessages + "/" + current.intervalMs + "ms | duplicates: " + current.duplicateLimit + " | mention limit: " + current.massMentionLimit + " | blocked phrases: " + current.blockedPhrases.length + " | invite links: " + (current.blockInvites ? "blocked" : "allowed"));
    if (sub === "on" || sub === "off") {
      await store.updateConfig(guild.id, c => ({ ...c, automod: { ...c.automod, enabled: sub === "on" } }));
      return void await message.reply("Automod is now " + sub.toUpperCase() + ". Review settings with s automod status.");
    }
    if (sub === "invites" && ["on", "off"].includes(rest[0])) {
      await store.updateConfig(guild.id, c => ({ ...c, automod: { ...c.automod, blockInvites: rest[0] === "on" } }));
      return void await message.reply("Discord invite-link filtering is now " + rest[0].toUpperCase() + ".");
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
    if (sub === "ignore" && ["channel", "role"].includes(rest[0]) && ["add", "remove"].includes(rest[1])) {
      const target = rest[0] === "channel" ? message.mentions.channels.first() : message.mentions.roles.first();
      if (!target || target.guild.id !== guild.id) return void await message.reply(rest[0] === "channel" ? "Mention a channel in this server." : "Mention a role in this server.");
      const field = rest[0] === "channel" ? "ignoredChannelIds" : "ignoredRoleIds";
      await store.updateConfig(guild.id, c => {
        const current = c.automod[field];
        const next = rest[1] === "add"
          ? [...new Set([...current, target.id])]
          : current.filter(id => id !== target.id);
        return { ...c, automod: { ...c.automod, [field]: next } };
      });
      return void await message.reply("Automod ignore list updated for " + rest[0] + " <" + (rest[0] === "channel" ? "#" : "@&") + target.id + ">.");
    }
    if (sub === "limits") {
      const [rate, interval, duplicates, mentions] = rest.map(Number);
      if (![rate, interval, duplicates, mentions].every(Number.isInteger)) return void await message.reply("Usage: s automod limits MAX_MESSAGES INTERVAL_MS DUPLICATE_LIMIT MENTION_LIMIT");
      if (rate < 3 || rate > 30 || interval < 3000 || interval > 60000 || duplicates < 2 || duplicates > 10 || mentions < 2 || mentions > 50) return void await message.reply("Limits: messages 3–30, interval 3000–60000ms, duplicates 2–10, mentions 2–50.");
      await store.updateConfig(guild.id, c => ({ ...c, automod: { ...c.automod, maxMessages: rate, intervalMs: interval, duplicateLimit: duplicates, massMentionLimit: mentions } }));
      return void await message.reply("Automod thresholds updated.");
    }
    return void await message.reply("Use s automod on|off|status, s automod action alert|delete, s automod invites on|off, s automod block add|remove phrase, s automod ignore channel|role add|remove, or s automod limits MAX_MESSAGES INTERVAL_MS DUPLICATE_LIMIT MENTION_LIMIT.");
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

  if (command === "security") {
    const [sub, setting, value] = args;
    const current = store.getConfig(guild.id).security;
    if (sub === "status") return void await message.reply(
      "Raid detection: " + (current.raidProtectionEnabled ? "ON" : "OFF") +
      " | threshold: " + current.raidJoinLimit + "/" + current.raidWindowMs + "ms" +
      " | new-account alerts: " + (current.accountAgeAlertsEnabled ? "ON" : "OFF") +
      " | minimum account age: " + current.minimumAccountAgeDays + " days."
    );
    if (sub === "account-age" && ["on", "off"].includes(setting)) {
      await store.updateConfig(guild.id, c => ({ ...c, security: { ...c.security, accountAgeAlertsEnabled: setting === "on" } }));
      return void await message.reply("New-account age alerts are now " + setting.toUpperCase() + ". Alerts only; no automatic action.");
    }
    if (sub === "account-age-days") {
      const days = Number(setting);
      if (!Number.isInteger(days) || days < 1 || days > 365) return void await message.reply("Set an account-age threshold from 1 to 365 days.");
      await store.updateConfig(guild.id, c => ({ ...c, security: { ...c.security, minimumAccountAgeDays: days } }));
      return void await message.reply("New-account alert threshold set to " + days + " days.");
    }
    return void await message.reply("Use s security status, s security account-age on|off, or s security account-age-days 7.");
  }

  if (command === "unban") {
    const id = args[0];
    if (!isSnowflake(id)) return void await message.reply("Usage: s unban USER_ID [reason].");
    await execute(message, store, command, id, reasonFrom(args, 1), () => guild.members.unban(id, reasonFrom(args, 1)));
    return;
  }

  const known = ["kick", "ban", "timeout", "untimeout", "warn", "warnings", "warninghistory", "removewarn", "clearwarnings"];
  if (!known.includes(command)) return void await message.reply("Unknown command. Use s help.");

  const targetToken = args[0];
  const mentionId = /^<@!?(\d{17,20})>$/.exec(targetToken || "")?.[1];
  const targetId = mentionId || targetToken;
  if (!isSnowflake(targetId)) return void await message.reply("Target not found. Mention a member, or use their Discord ID if they have left the server.");
  if (["warnings", "warninghistory", "removewarn", "clearwarnings"].includes(command)) {
    if (command === "warnings" || command === "warninghistory") {
      const records = command === "warnings"
        ? store.getWarnings(guild.id, targetId).map(w => ({ ...w, status: "active" }))
        : store.getWarningHistory(guild.id, targetId);
      if (!records.length) return void await message.reply(command === "warnings" ? "That member has no active warnings." : "That member has no warning history.");
      const targetLabel = await getUserMention(guild, targetId);
      const recordLines = await Promise.all(records.slice(0, 12).map(async w =>
        "**Warning #" + w.number + " — " + (w.status === "active" ? "ACTIVE" : w.status.toUpperCase()) + "**\nReason: " + w.reason + "\nModerator: " + await getUserMention(guild, w.moderatorId) + "\nDate: " + w.createdAt
      ));
      const embed = new EmbedBuilder()
        .setTitle((command === "warnings" ? "Active warnings for " : "Warning history for ") + targetLabel)
        .setDescription(recordLines.join("\n\n").slice(0, 4000));
      return void await message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    if (command === "clearwarnings") {
      try {
        const count = await store.clearWarnings(guild.id, targetId);
        await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason: "Archived and cleared " + count + " active warning(s)", result: "success" });
        return void await message.reply({ content: "Cleared " + count + " active warning(s) for " + userMention(targetId) + ". Their history was preserved.", allowedMentions: { users: [targetId] } });
      } catch (error) {
        await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason: "Could not persist warning cleanup: " + error.message, result: "failed" });
        return void await message.reply("Could not clear warnings because storage failed. No change was kept.");
      }
    }
    const warningNumber = Number(args[1]);
    if (!Number.isInteger(warningNumber) || warningNumber < 1) return void await message.reply("Usage: s removewarn @member WARNING_NUMBER. Example: s removewarn @member 2.");
    const currentWarnings = store.getWarnings(guild.id, targetId);
    const selectedWarning = currentWarnings.find(w => w.number === warningNumber);
    if (!selectedWarning) return void await message.reply("That active warning number does not exist. Use s warnings @member to see active warning numbers.");
    try {
      const removed = await store.removeWarning(guild.id, targetId, warningNumber);
      if (!removed) return void await message.reply("That active warning could not be found. Check s warnings @member again.");
      await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason: "Removed warning #" + warningNumber, result: "success" });
      return void await message.reply({ content: "Removed Warning #" + warningNumber + " from " + userMention(targetId) + "'s active warnings. Its history was preserved.", allowedMentions: { users: [targetId] } });
    } catch (error) {
      await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason: "Could not persist warning removal: " + error.message, result: "failed" });
      return void await message.reply("Could not remove that warning because storage failed. No change was kept.");
    }
  }

  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target) return void await message.reply("That member is not currently in this server. You can still view their warnings or history by Discord ID.");
  const reason = reasonFrom(args, command === "timeout" ? 2 : 1);
  if (command === "warn") {
    const roleError = target.id === message.author.id || target.id === guild.ownerId || (message.author.id !== guild.ownerId && member.roles.highest.comparePositionTo(target.roles.highest) <= 0);
    if (roleError) {
      const detail = "You cannot warn yourself, the server owner, or a member with an equal or higher role.";
      await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason: detail, result: "failed" });
      return void await message.reply(detail);
    }
    try {
      const record = await store.addWarning({ guildId: guild.id, targetId, moderatorId: message.author.id, reason });
      await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason, result: "success" });
      const warningNumber = record.number;
      return void await message.reply({ content: "Warning #" + warningNumber + " — " + userMention(targetId) + " warned by " + userMention(message.author.id) + ". Reason: " + reason, allowedMentions: { users: [targetId] } });
    } catch (error) {
      await logModeration(message.client, store, guild, { action: command, targetId, moderatorId: message.author.id, reason: "Could not persist warning: " + error.message, result: "failed" });
      return void await message.reply("Could not save that warning because storage failed. No warning was kept.");
    }
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
