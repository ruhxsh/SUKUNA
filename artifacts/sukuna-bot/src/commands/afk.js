const afkUsers = new Map();

function getKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

export async function handleAfkCommand(message, command, args) {
  if (command !== "afk") return false;

  const key = getKey(message.guild.id, message.author.id);
  const reason = args.join(" ").slice(0, 200) || "AFK";

  afkUsers.set(key, {
    reason,
    since: Date.now(),
  });

  await message.reply({
    content: `You are now AFK: **${reason}**`,
    allowedMentions: { repliedUser: false },
  });

  return true;
}

export async function handleAfkMessage(message) {
  if (!message.guild || message.author.bot) return;

  const ownKey = getKey(message.guild.id, message.author.id);
  const ownAfk = afkUsers.get(ownKey);

  if (ownAfk) {
    afkUsers.delete(ownKey);

    await message.reply({
      content: `Welcome back! Your AFK status has been removed.`,
      allowedMentions: { repliedUser: false },
    });
  }

  for (const user of message.mentions.users.values()) {
    if (user.bot) continue;

    const afk = afkUsers.get(getKey(message.guild.id, user.id));
    if (!afk) continue;

    await message.reply({
      content: `**${user.username}** is currently AFK: ${afk.reason}`,
      allowedMentions: { repliedUser: false, parse: [] },
    });
  }
}
