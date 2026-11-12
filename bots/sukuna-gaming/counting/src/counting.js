const NUMBER_LIKE_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_PATTERN = /^\d{1,100}$/;
const PREFIX_PATTERN = /^s(?:\s+([\s\S]*))?$/i;

function safeReply(message, content) {
  return message.reply({
    content,
    allowedMentions: { repliedUser: false, parse: [] },
  });
}

function hasPermission(permissionSet, permission) {
  return Boolean(permissionSet?.has?.(permission));
}

export async function handleCountingSetup(message, store, disable = false) {
  if (!message.guild || !hasPermission(message.member?.permissions, "ManageGuild")) {
    await safeReply(message, "You need the **Manage Server** permission to change counting settings.");
    return true;
  }

  if (disable) {
    await store.setChannel(message.guild.id, null);
    await safeReply(
      message,
      "Counting is disabled. Your current count, highest count, and last counter are preserved.",
    );
    return true;
  }

  const channel = message.mentions?.channels?.first?.();
  if (
    !channel ||
    channel.guild?.id !== message.guild.id ||
    typeof channel.isTextBased !== "function" ||
    !channel.isTextBased() ||
    typeof channel.permissionsFor !== "function"
  ) {
    await safeReply(message, "Mention a text channel in this server: `s setcounting #counting`.");
    return true;
  }

  const botMember = message.guild.members?.me;
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  const missing = ["ViewChannel", "SendMessages", "AddReactions", "ManageMessages"]
    .filter((permission) => !hasPermission(permissions, permission));

  if (missing.length > 0) {
    await safeReply(
      message,
      `I need these permissions in <#${channel.id}>: ${missing.map((item) => `\`${item}\``).join(", ")}.`,
    );
    return true;
  }

  const state = await store.setChannel(message.guild.id, channel.id);
  await safeReply(
    message,
    `Counting is enabled in <#${channel.id}>. The next number is **${(BigInt(state.currentCount) + 1n).toString()}**.`,
  );
  return true;
}

export async function handleCountingMessage(message, store, logger = console) {
  if (message.author?.bot || !message.guild || !message.channel) return false;

  const content = String(message.content ?? "").trim();
  if (!NUMBER_LIKE_PATTERN.test(content)) return false;

  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const state = store.getGuildState(guildId);
  if (!state.channelId || state.channelId !== channelId) return false;

  const botMember = message.guild.members?.me;
  const permissions = botMember ? message.channel.permissionsFor?.(botMember) : null;
  const canReact = hasPermission(permissions, "AddReactions");
  const canDelete = hasPermission(permissions, "ManageMessages");

  if (!canReact || !canDelete) {
    logger.error?.(
      `[SUKUNA COUNTING] Missing AddReactions or ManageMessages in channel ${channelId} (server ${guildId}).`,
    );
    return true;
  }

  const isValidInteger = INTEGER_PATTERN.test(content);
  let result;

  try {
    result = isValidInteger
      ? await store.recordCount(guildId, content, message.author.id)
      : { accepted: false, reason: "invalid-number" };
  } catch (error) {
    logger.error?.("[SUKUNA COUNTING] Could not persist a counting entry.", error);
    return true;
  }

  if (result.accepted) {
    try {
      await message.react("✅");
    } catch (error) {
      logger.error?.("[SUKUNA COUNTING] Count was saved, but the reaction failed.", error);
    }
    return true;
  }

  try {
    await message.delete();
  } catch (error) {
    logger.error?.("[SUKUNA COUNTING] Could not delete an invalid counting message.", error);
  }

  return true;
}

export async function handleCountingCommand(message, store) {
  const match = PREFIX_PATTERN.exec(String(message.content ?? "").trim());
  if (!match) return false;

  const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const command = (words.shift() ?? "").toLowerCase();

  if (command === "setcounting") {
    await handleCountingSetup(message, store, false);
    return true;
  }

  if (command === "disablecounting") {
    await handleCountingSetup(message, store, true);
    return true;
  }

  if (command === "counting") {
    const state = store.getGuildState(message.guild.id);
    await safeReply(
      message,
      state.channelId
        ? `Counting is active in <#${state.channelId}>. Current: **${state.currentCount}** · Highest: **${state.highestCount}** · Next: **${(BigInt(state.currentCount) + 1n).toString()}**.`
        : `Counting is disabled. Saved current count: **${state.currentCount}** · Highest: **${state.highestCount}**.`,
    );
    return true;
  }

  return false;
}
