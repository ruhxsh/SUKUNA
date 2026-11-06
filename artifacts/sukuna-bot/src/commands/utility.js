
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import {
  requireBotChannelPermission,
  requirePermission,
  requireTextChannel,
  UserFacingError,
} from "../permissions.js";

const HELP_PAGES = [
  {
    title: "Getting started · 1/7",
    description: [
      "Commands start with `s` or `S`.",
      "Use the buttons below to browse the help pages.",
      "",
      "**General utilities**",
      "`s help` — open this paginated help center",
      "`s ping` — show bot response latency",
      "`s userinfo [@user]` — show account and server details",
      "`s serverinfo` — show server information",
      "`s av [@user]` — show an avatar",
      "`s poll question` — create a yes/no poll",
      "",
      "**Staff messaging**",
      "`s announce message` — post a staff announcement (Manage Server)",
      "`s say message` — send as the bot here (Manage Messages)",
      "`s say #channel message` — send as the bot in another channel",
    ].join("\n"),
  },
  {
    title: "Moderation · 2/7",
    description: [
      "These commands require the relevant staff permissions.",
      "`s kick @user [reason]` — kick a member",
      "`s ban @user [reason]` — ban a member",
      "`s timeout @user 10m [reason]` — timeout a member",
      "`s untimeout @user` — remove a timeout",
      "`s warn @user [reason]` — save a warning",
      "`s warnings @user` — view saved warnings",
      "`s clearwarnings @user` — clear saved warnings",
      "`s purge 25` — delete 1–100 recent messages",
      "",
      "Timeout examples: `30s`, `10m`, `2h`, `1d`, `1w` (maximum 28 days).",
    ].join("\n"),
  },
  {
    title: "Server security · 3/7",
    description: [
      "Security configuration requires **Manage Server**.",
      "",
      "**Automatic moderation**",
      "`s automod` — view current settings and commands",
      "`s automod on` / `s automod off` — enable or disable",
      "`s automod messages 6` — set message-rate limit (2–30)",
      "`s automod duplicates 3` — set duplicate limit (2–30)",
      "`s automod mentions 6` — set mention limit (2–30)",
      "`s automod action warn` — choose `warn` or `timeout`",
      "`s automod timeout 60` — set timeout seconds (1–600)",
      "",
      "**Raid protection**",
      "`s raid` — view raid settings",
      "`s raid on` / `s raid off` — enable or disable",
      "`s raid joins 8` — set join threshold (2–30)",
    ].join("\n"),
  },
  {
    title: "Roles and server setup · 4/7",
    description: [
      "**Role management**",
      "`s role @user @role` — assign a role",
      "`s removerole @user @role` — remove a role",
      "`s addselfrole @role` — approve a self-assignable role",
      "`s removeselfrole @role` — remove it from the approved list",
      "`s rolepanel` — publish the self-role button panel",
      "",
      "**Server setup** (Manage Server unless noted)",
      "`s setwelcome #channel` / `s disablewelcome` — welcome messages",
      "`s setmodlog #channel` / `s disablemodlog` — moderation/error logs",
      "`s setautorole @role` / `s disableautorole` — new-member role",
      "`s setcounting #channel` / `s disablecounting` — counting channel",
      "`s config` — view this server's saved bot settings",
    ].join("\n"),
  },
  {
    title: "AFK and reaction roles · 5/7",
    description: [
      "**AFK status**",
      "`s afk [reason]` — set your AFK status and optional reason",
      "Sukuna notifies people who mention you and clears your AFK status when you speak again.",
      "AFK status is saved across bot restarts.",
      "",
      "**Multiple reaction-role button panels** (Manage Server)",
      "`s rr add <panel> @role <label>` — add a role button",
      "`s rr remove <panel> @role` — remove a role from a panel",
      "`s rr panel <panel> [title]` — publish the panel",
      "`s rr list` — list configured panels",
      "`s rr delete <panel>` — delete a panel configuration",
      "",
      "Example: `s rr add colors @Blue Blue` then `s rr panel colors`.",
      "Only eligible roles below Sukuna's highest role can be assigned.",
    ].join("\n"),
  },
  {
    title: "Temporary voice rooms and tickets · 6/7",
    description: [
      "**Temporary voice rooms**",
      "Staff: `s voice setup` (run while in the lobby) or `s voice setup #VoiceLobby`",
      "Staff: `s voice disable` — disable the system and remove its tracked rooms",
      "Room owner: `s voice rename New Name`",
      "Room owner: `s voice limit 10` (use `0` for unlimited)",
      "Room owner: `s voice lock` / `s voice unlock`",
      "Room owner: `s voice hide` / `s voice reveal`",
      "Room owner: `s voice allow @member` / `s voice deny @member`",
      "Room owner: `s voice kick @member`",
      "Empty temporary rooms are automatically deleted.",
      "",
      "**Support tickets**",
      "Staff: `s ticket setup #TicketCategory #TranscriptChannel`",
      "In a ticket: `s ticket claim`, `s ticket close`, `s ticket reopen`, `s ticket delete`",
      "Closing with `s ticket close` saves a text transcript to the configured channel.",
    ].join("\n"),
  },
  {
    title: "Anime and relationships · 7/7",
    description: [
      "**Anime interactions**",
      "`s hug @user` · `s kiss @user` · `s pat @user` · `s cuddle @user`",
      "`s punch @user` · `s slap @user` · `s poke @user` · `s bite @user`",
      "`s wave @user` · `s highfive @user` · `s dance`",
      "",
      "**Relationships**",
      "`s marry @user` — send a proposal with Accept and Decline buttons",
      "`s married` — show your spouse",
      "`s divorce` — request confirmation before ending a marriage",
      "`s couple @user` — check your relationship",
      "`s ship @user` — show a playful compatibility score",
      "`s proposals` — list pending proposals",
      "`s marriage` — show marriage commands and your status",
      "",
      "Use the Previous button to return to any earlier page.",
    ].join("\n"),
  },
];

async function reply(message, content) {
  return message.reply({
    content,
    allowedMentions: { repliedUser: false, parse: [] },
  });
}

function requireMessageContent(args, command) {
  const content = args.join(" ").trim();

  if (!content) {
    throw new UserFacingError(
      `Add some text: \`s ${command} your message\`.`,
    );
  }

  if (content.length > 2_000) {
    throw new UserFacingError("Keep the message under 2,000 characters.");
  }

  return content;
}

function buildHelpPage(page) {
  const current = Math.max(0, Math.min(HELP_PAGES.length - 1, page));
  const data = HELP_PAGES[current];
  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(`Sukuna Help Center — ${data.title}`)
    .setDescription(data.description)
    .setFooter({ text: `Page ${current + 1} of ${HELP_PAGES.length} · Commands use the s prefix` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sk:help:${current - 1}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(current === 0),
    new ButtonBuilder()
      .setCustomId(`sk:help:${current + 1}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(current === HELP_PAGES.length - 1),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

async function handleHelp(message) {
  await message.reply(buildHelpPage(0));
}

export async function handleHelpInteraction(interaction) {
  if (!interaction.isButton() || !interaction.customId?.startsWith("sk:help:")) {
    return false;
  }
  const page = Number(interaction.customId.split(":")[2]);
  if (!Number.isInteger(page) || page < 0 || page >= HELP_PAGES.length) {
    await interaction.reply({ content: "That help page is no longer available.", ephemeral: true });
    return true;
  }
  await interaction.update(buildHelpPage(page));
  return true;
}

async function handleUserInfo(message) {
  const user = message.mentions.users.first() ?? message.author;

  const member =
    message.guild.members.cache.get(user.id) ??
    (await message.guild.members.fetch(user.id).catch(() => null));

  const joinedAt = member?.joinedTimestamp
    ? `<t:${Math.floor(member.joinedTimestamp / 1_000)}:F>`
    : "Not a current server member";

  const createdAt = `<t:${Math.floor(user.createdTimestamp / 1_000)}:F>`;

  const roles = member
    ? member.roles.cache
        .filter((role) => role.id !== message.guild.id)
        .map((role) => `<@&${role.id}>`)
        .slice(0, 20)
        .join(", ") || "No roles"
    : "Not a current server member";

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(`User information: ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "User ID", value: user.id, inline: true },
      { name: "Account created", value: createdAt, inline: true },
      { name: "Joined server", value: joinedAt, inline: true },
      { name: "Roles", value: roles.slice(0, 1_024) },
    );

  await message.reply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleServerInfo(message) {
  const guild = message.guild;

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(guild.name)
    .setThumbnail(guild.iconURL({ size: 256 }))
    .addFields(
      { name: "Server ID", value: guild.id, inline: true },
      { name: "Owner ID", value: guild.ownerId ?? "Unavailable", inline: true },
      { name: "Members", value: String(guild.memberCount), inline: true },
      { name: "Channels", value: String(guild.channels.cache.size), inline: true },
      { name: "Roles", value: String(guild.roles.cache.size), inline: true },
      {
        name: "Created",
        value: `<t:${Math.floor(guild.createdTimestamp / 1_000)}:F>`,
        inline: true,
      },
    );

  await message.reply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleAvatar(message) {
  const user = message.mentions.users.first() ?? message.author;
  const url = user.displayAvatarURL({ size: 1_024 });

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(`${user.tag}'s avatar`)
    .setImage(url);

  await message.reply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handlePoll(message, args) {
  requireTextChannel(message.channel);

  requireBotChannelPermission(
    message.guild,
    message.channel,
    PermissionFlagsBits.SendMessages,
    "Send Messages",
  );

  requireBotChannelPermission(
    message.guild,
    message.channel,
    PermissionFlagsBits.EmbedLinks,
    "Embed Links",
  );

  requireBotChannelPermission(
    message.guild,
    message.channel,
    PermissionFlagsBits.AddReactions,
    "Add Reactions",
  );

  const question = args.join(" ").trim() || "Vote on the options below.";

  if (question.length > 2_000) {
    throw new UserFacingError("Keep the poll question under 2,000 characters.");
  }

  const poll = await message.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle("Poll")
        .setDescription(question)
        .setFooter({ text: `Poll by ${message.author.tag}` })
        .setTimestamp(),
    ],
  });

  await poll.react("👍");
  await poll.react("👎");
}

async function handleAnnounce(message, args) {
  requirePermission(message, PermissionFlagsBits.ManageGuild, "Manage Server");
  requireTextChannel(message.channel);

  requireBotChannelPermission(
    message.guild,
    message.channel,
    PermissionFlagsBits.SendMessages,
    "Send Messages",
  );

  const content = requireMessageContent(args, "announce");

  await message.channel.send({
    content,
    allowedMentions: { parse: [] },
  });
}

async function handleSay(message, args) {
  requirePermission(message, PermissionFlagsBits.ManageMessages, "Manage Messages");

  if (!message.guild) {
    throw new UserFacingError("This command can only be used in a server.");
  }

  requireTextChannel(message.channel);

  const targetChannel = message.mentions.channels.find(
    (channel) => channel.guildId === message.guild.id,
  );

  const destination = targetChannel ?? message.channel;

  requireTextChannel(destination);

  const contentArgs = targetChannel
    ? args.filter((arg) => arg !== `<#${targetChannel.id}>`)
    : args;

  const content = requireMessageContent(contentArgs, "say");

  requireBotChannelPermission(
    message.guild,
    destination,
    PermissionFlagsBits.SendMessages,
    "Send Messages",
  );

  requireBotChannelPermission(
    message.guild,
    message.channel,
    PermissionFlagsBits.ManageMessages,
    "Manage Messages",
  );

  await destination.send({
    content,
    allowedMentions: {
      parse: [],
      users: message.mentions.users.map((user) => user.id),
      roles: message.mentions.roles.map((role) => role.id),
    },
  });

  await message.delete();
}

export async function handleUtility(message, command, args, client) {
  switch (command) {
    case "help":
      await handleHelp(message);
      return true;

    case "ping":
      await reply(
        message,
        `Pong! WebSocket latency: ${Math.round(client.ws.ping)} ms.`,
      );
      return true;

    case "userinfo":
      await handleUserInfo(message);
      return true;

    case "serverinfo":
      await handleServerInfo(message);
      return true;

    case "av":
      await handleAvatar(message);
      return true;

    case "poll":
      await handlePoll(message, args);
      return true;

    case "announce":
      await handleAnnounce(message, args);
      return true;

    case "say":
      await handleSay(message, args);
      return true;

    default:
      return false;
  }
}
