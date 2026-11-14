import { AuditLogEvent, EmbedBuilder, PermissionFlagsBits } from "discord.js";

const MAX_CACHED_MESSAGES = 5000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const recentMessages = new Map();

function snapshot(message) {
  return {
    id: message.id,
    guildId: message.guildId || message.guild?.id,
    channelId: message.channelId || message.channel?.id,
    authorId: message.author?.id || null,
    authorName: message.member?.displayName || message.author?.globalName || message.author?.username || "Unknown author",
    content: typeof message.content === "string" ? message.content : "",
    attachments: [...(message.attachments?.values?.() || [])].slice(0, 10).map(file => ({
      name: String(file.name || "attachment").slice(0, 180),
      url: String(file.url || "").slice(0, 1000),
      size: Number.isFinite(file.size) ? file.size : null
    })),
    createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
    cachedAt: Date.now()
  };
}

export function cacheMessage(message, store) {
  if (!message?.guildId && !message?.guild?.id) return;
  if (!message.id || message.author?.bot) return;
  const guildId = message.guildId || message.guild?.id;
  if (!store?.getConfig?.(guildId)?.deletedMessageLogChannelId) return;
  const previous = recentMessages.get(message.id);
  if (!message.author && !previous) return;
  const item = snapshot(message);
  if (previous) {
    if (!item.authorId) item.authorId = previous.authorId;
    if (item.authorName === "Unknown author") item.authorName = previous.authorName;
    if (message.partial && !item.content) item.content = previous.content;
    if (!item.attachments.length) item.attachments = previous.attachments;
    if (!item.createdAt) item.createdAt = previous.createdAt;
  }
  if (!item.guildId || !item.channelId) return;
  recentMessages.delete(item.id);
  recentMessages.set(item.id, item);
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [id, value] of recentMessages) {
    if (value.cachedAt < cutoff || recentMessages.size > MAX_CACHED_MESSAGES) recentMessages.delete(id);
    else if (recentMessages.size <= MAX_CACHED_MESSAGES) break;
  }
}

export function resetDeletedMessageCacheForTests() {
  recentMessages.clear();
}

async function identifyDeleter(message, record, waitMs = 700, expectedCount = 1) {
  const guild = message.guild || message.client?.guilds?.cache?.get(message.guildId);
  const authorId = record?.authorId || message.author?.id;
  const channelId = message.channelId || message.channel?.id || record?.channelId;
  if (!guild || !authorId || !channelId) return "Unknown (Discord did not provide deletion details)";
  if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
    return "Unknown (the bot is missing View Audit Log permission)";
  }
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 10 });
    const now = Date.now();
    const matches = [...logs.entries.values()].filter(entry =>
      entry.targetId === authorId &&
      entry.extra?.channel?.id === channelId &&
      entry.extra?.count === expectedCount &&
      now - entry.createdTimestamp >= 0 &&
      now - entry.createdTimestamp <= 5000 &&
      entry.executorId
    );
    if (matches.length !== 1) {
      return "Unknown (Discord did not provide an unambiguous deletion record)";
    }
    const executorId = matches[0].executorId;
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (member) return member.displayName + " (<@" + executorId + ">)";
    const user = await guild.client.users.fetch(executorId).catch(() => null);
    return user ? user.username + " (<@" + executorId + ">)" : "<@" + executorId + ">";
  } catch (error) {
    console.warn("Could not identify deleted-message actor:", error.message);
    return "Unknown (audit log could not be read)";
  }
}

function attachmentSummary(attachments) {
  if (!attachments.length) return "None";
  return attachments.map(file =>
    (file.name || "attachment") +
    (file.size ? " (" + file.size + " bytes)" : "") +
    (file.url ? "\n" + file.url : "")
  ).join("\n").slice(0, 1000);
}

export async function handleDeletedMessage(message, store, options = {}) {
  const guildId = message?.guildId || message?.guild?.id;
  const guild = message?.guild || message?.client?.guilds?.cache?.get(guildId);
  const channelId = message?.channelId || message?.channel?.id;
  const messageId = message?.id;
  if (!guild || !guildId || !channelId || !messageId || message.author?.bot) return;

  const config = store.getConfig(guildId);
  const logChannelId = config.deletedMessageLogChannelId;
  if (!logChannelId) {
    recentMessages.delete(messageId);
    return;
  }

  const cached = recentMessages.get(messageId);
  recentMessages.delete(messageId);
  const current = !message.partial && typeof message.content === "string" ? snapshot(message) : null;
  const record = cached || current;
  const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!logChannel?.isTextBased() || !logChannel.send) {
    console.warn("Deleted-message log channel is missing or unavailable:", logChannelId);
    return;
  }
  const permissions = logChannel.permissionsFor(guild.members.me);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    console.warn("Deleted-message log channel lacks View Channel, Send Messages, or Embed Links permission.");
    return;
  }

  const deleter = options.deleter || await identifyDeleter(message, record, options.waitMs ?? 700, options.bulkCount ?? 1);
  const author = record
    ? record.authorName + (record.authorId ? " (<@" + record.authorId + ">)" : "")
    : message.author?.username || "Unknown author";
  const content = record?.content || "";
  const attachments = record?.attachments || [];
  const unavailable = !record
    ? "Message content unavailable: it was not cached by SUKUNA before deletion. Discord does not allow the bot to retrieve deleted content afterward."
    : content
      ? content
      : attachments.length
        ? "No text content (attachment-only message)."
        : "No text content was present.";

  const embed = new EmbedBuilder()
    .setTitle("Message Deleted")
    .setColor(0xe67e22)
    .addFields(
      { name: "Author", value: author.slice(0, 256), inline: true },
      { name: "Deleted by", value: deleter.slice(0, 256), inline: true },
      { name: "Channel", value: ("<#" + channelId + "> (ID: " + channelId + ")").slice(0, 256), inline: false },
      { name: "Attachments", value: attachmentSummary(attachments).slice(0, 800), inline: false },
      { name: "Message time", value: (record?.createdAt || message.createdAt?.toISOString?.() || "Unavailable").slice(0, 128), inline: true },
      { name: "Deleted time", value: new Date().toISOString().slice(0, 128), inline: true }
    )
    .setDescription((content || unavailable).slice(0, 3500))
    .setFooter({ text: "Message ID: " + messageId + (content.length > 3500 ? " • Content shortened to fit Discord's embed limit" : "") });

  try {
    await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("Could not send deleted-message log:", error.message);
  }
}

export async function handleBulkDeletedMessages(messages, store) {
  const groups = new Map();
  for (const message of messages.values()) {
    const record = recentMessages.get(message.id) || (!message.partial ? snapshot(message) : null);
    const guildId = message.guildId || message.guild?.id;
    if (!store.getConfig(guildId).deletedMessageLogChannelId) continue;
    const authorId = record?.authorId || message.author?.id || "unknown";
    const channelId = message.channelId || message.channel?.id || record?.channelId || "unknown";
    const key = guildId + ":" + channelId + ":" + authorId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ message, record });
  }
  for (const group of groups.values()) {
    const first = group[0];
    const deleter = await identifyDeleter(first.message, first.record, 700, group.length);
    for (const item of group) {
      await handleDeletedMessage(item.message, store, { waitMs: 0, bulkCount: group.length, deleter });
    }
  }
}
