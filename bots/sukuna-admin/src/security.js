import { AuditLogEvent, PermissionFlagsBits } from "discord.js";
import { logModeration } from "./logger.js";

const messageWindows = new Map();
const joinWindows = new Map();
const alertTimes = new Map();
const MAX_TRACKED_KEYS = 20000;

function prune(items, cutoff) {
  while (items.length && items[0] < cutoff) items.shift();
}
function setBounded(map, key, value) {
  if (!map.has(key) && map.size >= MAX_TRACKED_KEYS) map.delete(map.keys().next().value);
  map.set(key, value);
}
function isIgnored(message, config) {
  if (config.automod.ignoredChannelIds.includes(message.channelId)) return true;
  return message.member?.roles?.cache?.some(role => config.automod.ignoredRoleIds.includes(role.id)) || false;
}
function isExcessiveCaps(content) {
  const letters = content.match(/[a-z]/gi) || [];
  if (letters.length < 10) return false;
  const uppercase = letters.filter(letter => letter === letter.toUpperCase()).length;
  return uppercase / letters.length >= 0.7;
}

export async function handleAutomodMessage(message, store) {
  if (!message.guild || message.author.bot || message.webhookId || !message.member) return false;
  const config = store.getConfig(message.guild.id);
  const rules = config.automod;
  if (!rules.enabled || isIgnored(message, config)) return false;

  const now = Date.now();
  const key = message.guild.id + ":" + message.author.id;
  const state = messageWindows.get(key) || { times: [], recent: [] };
  prune(state.times, now - rules.intervalMs);
  state.times.push(now);
  if (state.times.length > rules.maxMessages + 1) state.times.splice(0, state.times.length - rules.maxMessages - 1);
  const normalized = message.content.toLowerCase().replace(/\s+/g, " ").trim();
  state.recent = state.recent.filter(item => now - item.time <= rules.intervalMs);
  if (normalized) state.recent.push({ content: normalized, time: now });
  if (state.recent.length > 100) state.recent.splice(0, state.recent.length - 100);
  setBounded(messageWindows, key, state);

  let violation = null;
  if (state.times.length > rules.maxMessages) violation = "Message rate exceeded configured limit";
  else if (normalized && state.recent.filter(item => item.content === normalized).length >= rules.duplicateLimit) violation = "Repeated message detected";
  else if (rules.blockMentions !== false && (message.mentions.everyone || message.mentions.users.size + message.mentions.roles.size >= rules.massMentionLimit)) violation = "Mass mention limit exceeded";
  else if (normalized && rules.blockInvites && /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[a-z0-9-]+/i.test(normalized)) violation = "Unwanted Discord invite link detected";
  else if (normalized && rules.blockLinks && /(?:https?:\/\/|www\.)\S+|(?:^|\s)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/i.test(normalized)) violation = "Link blocking is enabled";
  else if (normalized && rules.blockCaps && isExcessiveCaps(message.content)) violation = "Excessive uppercase message detected";
  else if (normalized) {
    const whitelist = new Set((rules.whitelistPhrases || []).map(phrase => phrase.toLowerCase()));
    const blocked = rules.blockedPhrases.find(phrase =>
      normalized.includes(phrase.toLowerCase()) && !whitelist.has(phrase.toLowerCase())
    );
    if (blocked) violation = "Configured blocked phrase detected: " + blocked;
  }
  if (!violation) return false;

  let result = "alert";
  if (rules.action === "delete") {
    try {
      await message.delete();
      result = "success";
    } catch (error) {
      result = "failed";
      console.warn("Automod could not delete violating message:", error.message);
    }
  }
  await logModeration(message.client, store, message.guild, {
    action: "automod", targetId: message.author.id, moderatorId: message.client.user.id,
    reason: violation, result
  });
  return true;
}

export async function handleRaidJoin(member, store) {
  const config = store.getConfig(member.guild.id);
  const rules = config.security;
  const accountCreated = member.user?.createdTimestamp;
  const accountAgeMs = Number.isFinite(accountCreated) ? Date.now() - accountCreated : null;
  const belowAgeLimit = accountAgeMs !== null && accountAgeMs < rules.minimumAccountAgeDays * 86400000;

  const suspiciousSignals = rules.suspiciousAccountDetectionEnabled && belowAgeLimit && member.user?.avatar === null;
  if (rules.accountAgeAlertsEnabled && belowAgeLimit && !suspiciousSignals) {
    await logModeration(member.client, store, member.guild, {
      action: "new-account-alert", targetId: member.id, moderatorId: member.client.user.id,
      reason: "Account age is below the configured " + rules.minimumAccountAgeDays + "-day threshold. Alert only.",
      result: "alert"
    });
  }
  if (suspiciousSignals) {
    await logModeration(member.client, store, member.guild, {
      action: "suspicious-account-alert", targetId: member.id, moderatorId: member.client.user.id,
      reason: "Combined signals: account is younger than " + rules.minimumAccountAgeDays +
        " days and uses a default avatar. This is a review alert, not proof of abuse; no punishment was applied.",
      result: "alert"
    });
  }

  if (!rules.raidProtectionEnabled || (rules.raidWhitelistIds || []).includes(member.id)) return;
  const now = Date.now();
  const key = member.guild.id;
  const joins = joinWindows.get(key) || [];
  prune(joins, now - rules.raidWindowMs);
  joins.push(now);
  if (joins.length > 100) joins.splice(0, joins.length - 100);
  setBounded(joinWindows, key, joins);
  if (joins.length < rules.raidJoinLimit) return;

  const lastAlert = alertTimes.get(key) || 0;
  if (now - lastAlert < rules.alertCooldownMs) return;
  setBounded(alertTimes, key, now);
  await logModeration(member.client, store, member.guild, {
    action: "raid-alert", targetId: member.id, moderatorId: member.client.user.id,
    reason: joins.length + " non-whitelisted joins within " + rules.raidWindowMs +
      "ms. Configured response: " + rules.raidAction + ". No automatic punishment was applied.",
    result: "alert"
  });
}

export async function handleAuditLogEntry(entry, guild, store, client) {
  if (!entry.executorId || entry.executorId === client.user.id) return;
  if (![AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd].includes(entry.action)) return;
  const actor = await guild.members.fetch(entry.executorId).catch(() => null);
  if (!actor) return;
  const required = entry.action === AuditLogEvent.MemberKick ? PermissionFlagsBits.KickMembers : PermissionFlagsBits.BanMembers;
  if (actor.permissions.has(PermissionFlagsBits.Administrator) || actor.permissions.has(required)) return;
  await logModeration(client, store, guild, {
    action: "unauthorized-moderation-alert",
    targetId: entry.targetId || "Unknown",
    moderatorId: entry.executorId,
    reason: "Audit log recorded a kick/ban by an account without the matching server permission. Review manually; no automatic action was taken.",
    result: "alert"
  });
}

export function resetSecurityMemoryForTests() {
  messageWindows.clear();
  joinWindows.clear();
  alertTimes.clear();
}
