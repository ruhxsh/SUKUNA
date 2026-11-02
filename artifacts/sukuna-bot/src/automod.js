
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

async function logAction(message, store, reason, action) {
  const config = store.getGuildConfig(message.guild.id);
  const logChannelId = config.modLogChannelId;

  if (!logChannelId) return;

  const channel = await message.guild.channels
    .fetch(logChannelId)
    .catch(() => null);

  if (!channel?.isTextBased() || !channel.permissionsFor(message.guild.members.me)?.has("SendMessages")) {
    return;
  }

  await channel.send({
    embeds: [{
      color: 0xe67e22,
      title: "Automatic moderation",
      description:
        `**Member:** ${message.author.tag}\n` +
        `**Action:** ${action}\n` +
        `**Reason:** ${reason}\n` +
        `**Channel:** ${message.channel}`,
      timestamp: new Date().toISOString(),
    }],
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

export async function handleAutoModeration(message, store) {
  if (!message.guild || message.author.bot || !message.member) {
    return false;
  }

  const member = message.member;

  // Exclude administrators and staff who manage messages or members.
  if (
    member.permissions.has("Administrator") ||
    member.permissions.has("ManageMessages") ||
    member.permissions.has("ModerateMembers")
  ) {
    return false;
  }

  const config = store.getGuildConfig(message.guild.id);

  // Automod is inactive unless explicitly enabled in server settings.
  if (config.autoModEnabled !== true) {
    return false;
  }

  const now = Date.now();
  const key = getMemberKey(message);
  const content = message.content.trim().toLowerCase();

  const entries = cleanOldMessages(
    recentMessages.get(key) ?? [],
    now,
  );

  entries.push({ time: now, content });
  recentMessages.set(key, entries);

  const messageLimit = config.autoModMessageLimit ?? DEFAULTS.messageLimit;
  const mentionLimit = config.autoModMentionLimit ?? DEFAULTS.mentionLimit;
  const duplicateLimit = config.autoModDuplicateLimit ?? DEFAULTS.duplicateLimit;

  const duplicateCount = entries.filter(
    (entry) => entry.content === content,
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

  // Delete the triggering message only if the bot has permission.
  const canDelete = message.channel
    .permissionsFor(message.guild.members.me)
    ?.has("ManageMessages");

  if (!canDelete) {
    await logAction(message, store, `${reason}; message could not be deleted`, "Logged only");
    return false;
  }

  await message.delete().catch(() => {});

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

  await logAction(message, store, reason, action);

  return true;
}
