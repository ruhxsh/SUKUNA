
const DEFAULTS = {
  windowMs: 7000,
  messageLimit: 6,
  duplicateLimit: 3,
  mentionLimit: 6,
  cooldownMs: 15000,
};

const recentMessages = new Map();
const actionCooldowns = new Map();

function getMemberKey(message) {
  return `${message.guild.id}:${message.author.id}`;
}

function cleanOldMessages(entries, now) {
  return entries.filter((entry) => now - entry.time <= DEFAULTS.windowMs);
}

async function logAction(message, reason) {
  const logChannelId = message.guild?.members?.me
    ? message.client?.store?.getGuildConfig?.(message.guild.id)?.modLogChannelId
    : null;

  if (!logChannelId) return;

  const channel = await message.guild.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  await channel.send({
    embeds: [{
      color: 0xe67e22,
      title: "Automatic moderation",
      description: `**Member:** ${message.author.tag}\n**Reason:** ${reason}\n**Channel:** ${message.channel}`,
      timestamp: new Date().toISOString(),
    }],
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

export async function handleAutoModeration(message, store) {
  if (!message.guild || message.author.bot || !message.member) return false;

  const member = message.member;

  // Do not automatically moderate server administrators or moderators.
  if (
    member.permissions.has("Administrator") ||
    member.permissions.has("ManageMessages") ||
    member.permissions.has("ModerateMembers")
  ) {
    return false;
  }

  const now = Date.now();
  const key = getMemberKey(message);
  const entries = cleanOldMessages(recentMessages.get(key) ?? [], now);

  entries.push({
    time: now,
    content: message.content.trim().toLowerCase(),
  });

  recentMessages.set(key, entries);

  const config = store.getGuildConfig(message.guild.id);
  const messageLimit = config.autoModMessageLimit ?? DEFAULTS.messageLimit;
  const mentionLimit = config.autoModMentionLimit ?? DEFAULTS.mentionLimit;
  const duplicateLimit = config.autoModDuplicateLimit ?? DEFAULTS.duplicateLimit;

  const duplicateCount = entries.filter(
    (entry) => entry.content === message.content.trim().toLowerCase(),
  ).length;

  const mentionCount =
    message.mentions.users.size + message.mentions.roles.size;

  let reason = null;

  if (mentionCount >= mentionLimit) {
    reason = `Excessive mentions (${mentionCount})`;
  } else if (duplicateCount >= duplicateLimit) {
    reason = `Repeated message (${duplicateCount} times)`;
  } else if (entries.length >= messageLimit) {
    reason = `Message rate exceeded (${entries.length} messages)`;
  }

  if (!reason) return false;

  const lastAction = actionCooldowns.get(key) ?? 0;
  if (now - lastAction < DEFAULTS.cooldownMs) return false;

  actionCooldowns.set(key, now);

  await message.delete().catch(() => {});
  await logAction(message, reason);

  const action = config.autoModAction ?? "warn";

  if (action === "timeout") {
    const duration = Math.min(
      config.autoModTimeoutMs ?? 60000,
      10 * 60 * 1000,
    );

    await member.timeout(duration, reason).catch(() => {});
  } else if (action === "warn") {
    await store.addWarning(
      message.guild.id,
      message.author.id,
      message.client.user.id,
      `Automatic moderation: ${reason}`,
    ).catch(() => {});
  }

  return true;
}
