import { EmbedBuilder } from "discord.js";

async function actorLabel(guild, id) {
  if (!/^\d{17,20}$/.test(String(id || ""))) return "Unknown member";
  const member = await guild.members.fetch(id).catch(() => null);
  if (member) return member.displayName + " (<@" + id + ">)";
  const user = await guild.client.users.fetch(id).catch(() => null);
  return user ? user.username + " (<@" + id + ">)" : "<@" + id + ">";
}

export async function logModeration(client, store, guild, details) {
  const entry = {
    action: String(details.action || "unknown").slice(0, 80),
    targetId: String(details.targetId || "N/A"),
    moderatorId: String(details.moderatorId || "N/A"),
    reason: String(details.reason || "No reason supplied").slice(0, 1000),
    duration: String(details.duration || "N/A").slice(0, 80),
    result: String(details.result || "unknown"),
    timestamp: new Date().toISOString()
  };
  console.log("[MODERATION]", JSON.stringify({ guildId: guild?.id, ...entry }));
  if (!guild) return;
  const channelId = store.getConfig(guild.id).modLogChannelId;
  if (!channelId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.send) return;
    const [targetLabel, moderatorLabel] = await Promise.all([actorLabel(guild, entry.targetId), actorLabel(guild, entry.moderatorId)]);
    const embed = new EmbedBuilder().setTitle("Moderation: " + entry.action)
      .setColor(entry.result === "success" ? 0x2ecc71 : entry.result === "alert" ? 0xf39c12 : 0xe74c3c)
      .addFields(
        { name: "Target", value: targetLabel, inline: true },
        { name: "Moderator", value: moderatorLabel, inline: true },
        { name: "Result", value: entry.result, inline: true },
        { name: "Reason", value: entry.reason.slice(0, 1000) },
        { name: "Duration", value: entry.duration, inline: true },
        { name: "Time (UTC)", value: entry.timestamp, inline: true }
      );
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("Could not send moderation log:", error.message);
  }
}
