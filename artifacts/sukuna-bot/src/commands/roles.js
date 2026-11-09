import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { sendBotErrorLog, sendModerationLog } from "../logging.js";
import { handleCountingSetup } from "./counting.js";
import {
  mentionedMember,
  mentionedRole,
  mentionedTextChannel,
  requireBotPermission,
  requireManageableMember,
  requireManageableRole,
  requirePermission,
  requireTextChannel,
  selfAssignableRoleProblem,
  UserFacingError,
} from "../permissions.js";

const MAX_SELF_ASSIGNABLE_ROLES = 25;

function getTarget(message) {
  const member = mentionedMember(message);
  if (!member) throw new UserFacingError("Tag a server member.");
  return member;
}

function getRole(message) {
  const role = mentionedRole(message);
  if (!role) throw new UserFacingError("Mention a role, for example `@Members`.");
  return role;
}

async function reply(message, content) {
  return message.reply({ content, allowedMentions: { repliedUser: false } });
}

function requireRolePanelChannel(message) {
  requireTextChannel(message.channel);
  const botMember = message.guild.members.me;
  if (!botMember) throw new UserFacingError("I could not verify my server permissions.");
  const permissions = message.channel.permissionsFor(botMember);
  if (!permissions?.has(PermissionFlagsBits.SendMessages)) {
    throw new UserFacingError("I need Send Messages permission in this channel.");
  }
  if (!permissions.has(PermissionFlagsBits.EmbedLinks)) {
    throw new UserFacingError("I need Embed Links permission in this channel.");
  }
}

async function handleRoleChange(message, command, store) {
  requirePermission(message, PermissionFlagsBits.ManageRoles, "Manage Roles");
  requireBotPermission(message.guild, PermissionFlagsBits.ManageRoles, "Manage Roles");
  const target = getTarget(message);
  const role = getRole(message);
  requireManageableMember(message, target);
  requireManageableRole(message, role);

  const alreadyHasRole = target.roles.cache.has(role.id);
  if (command === "role" && alreadyHasRole) {
    await reply(message, `**${target.user.tag}** already has **${role.name}**.`);
    return;
  }
  if (command === "removerole" && !alreadyHasRole) {
    await reply(message, `**${target.user.tag}** does not have **${role.name}**.`);
    return;
  }

  const reason = `Role ${command === "role" ? "assigned" : "removed"} by ${message.author.tag}`;
  if (command === "role") {
    await target.roles.add(role, reason);
    await sendModerationLog({
      guild: message.guild,
      store,
      action: "Role assigned",
      moderator: message.author,
      target: target.user,
      reason: role.name,
    });
    await reply(message, `Added **${role.name}** to **${target.user.tag}**.`);
  } else {
    await target.roles.remove(role, reason);
    await sendModerationLog({
      guild: message.guild,
      store,
      action: "Role removed",
      moderator: message.author,
      target: target.user,
      reason: role.name,
    });
    await reply(message, `Removed **${role.name}** from **${target.user.tag}**.`);
  }
}

async function handleWelcomeChannel(message, store, disable = false) {
  requirePermission(message, PermissionFlagsBits.ManageGuild, "Manage Server");
  if (disable) {
    await store.setGuildConfig(message.guild.id, { welcomeChannelId: null });
    await reply(message, "Welcome messages are disabled.");
    return;
  }

  const channel = mentionedTextChannel(message);
  if (!channel?.isTextBased?.() || !channel.send) {
    throw new UserFacingError("Mention a text channel, for example `s setwelcome #welcome`.");
  }
  const permissions = channel.permissionsFor(message.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.SendMessages)) {
    throw new UserFacingError("I need Send Messages permission in that channel.");
  }

  await store.setGuildConfig(message.guild.id, { welcomeChannelId: channel.id });
  await reply(message, `Welcome messages will be sent in <#${channel.id}>.`);
}

async function handleModLogChannel(message, store, disable = false) {
  requirePermission(message, PermissionFlagsBits.ManageGuild, "Manage Server");
  if (disable) {
    await store.setGuildConfig(message.guild.id, { modLogChannelId: null });
    await reply(message, "Moderation and bot-error logging are disabled.");
    return;
  }

  const channel = mentionedTextChannel(message);
  if (!channel?.isTextBased?.() || !channel.send) {
    throw new UserFacingError("Mention a text channel, for example `s setmodlog #mod-log`.");
  }
  const permissions = channel.permissionsFor(message.guild.members.me);
  if (
    !permissions?.has(PermissionFlagsBits.SendMessages) ||
    !permissions.has(PermissionFlagsBits.EmbedLinks)
  ) {
    throw new UserFacingError("I need Send Messages and Embed Links in that channel.");
  }

  await store.setGuildConfig(message.guild.id, { modLogChannelId: channel.id });
  await reply(message, `Moderation actions and bot errors will be logged in <#${channel.id}>.`);
}

async function handleAutorole(message, store, disable = false) {
  requirePermission(message, PermissionFlagsBits.ManageGuild, "Manage Server");
  if (disable) {
    await store.setGuildConfig(message.guild.id, { autoRoleId: null });
    await reply(message, "Automatic member roles are disabled.");
    return;
  }

  requirePermission(message, PermissionFlagsBits.ManageRoles, "Manage Roles");
  const role = getRole(message);
  requireManageableRole(message, role);
  const problem = selfAssignableRoleProblem(role);
  if (problem) throw new UserFacingError(`That role cannot be used as an autorole: ${problem}`);

  await store.setGuildConfig(message.guild.id, { autoRoleId: role.id });
  await reply(message, `New members will automatically receive **${role.name}**.`);
}

async function handleSelfRole(message, command, store) {
  requirePermission(message, PermissionFlagsBits.ManageRoles, "Manage Roles");
  const role = getRole(message);
  requireManageableRole(message, role);
  const config = store.getGuildConfig(message.guild.id);
  const roleIds = config.selfAssignableRoleIds;

  if (command === "addselfrole") {
    const problem = selfAssignableRoleProblem(role);
    if (problem) throw new UserFacingError(`That role cannot be self-assigned: ${problem}`);
    if (roleIds.includes(role.id)) {
      await reply(message, `**${role.name}** is already approved for the role panel.`);
      return;
    }
    if (roleIds.length >= MAX_SELF_ASSIGNABLE_ROLES) {
      throw new UserFacingError("The role panel is full (maximum 25 roles).");
    }
    await store.setGuildConfig(message.guild.id, {
      selfAssignableRoleIds: [...roleIds, role.id],
    });
    await reply(message, `Members can now self-assign **${role.name}**. Run \`s rolepanel\` to post the updated panel.`);
    return;
  }

  if (!roleIds.includes(role.id)) {
    await reply(message, `**${role.name}** is not on the self-assignable list.`);
    return;
  }
  await store.setGuildConfig(message.guild.id, {
    selfAssignableRoleIds: roleIds.filter((id) => id !== role.id),
  });
  await reply(message, `Removed **${role.name}** from the self-assignable list.`);
}

async function handleRolePanel(message, store) {
  requirePermission(message, PermissionFlagsBits.ManageRoles, "Manage Roles");
  requireBotPermission(message.guild, PermissionFlagsBits.ManageRoles, "Manage Roles");
  requireRolePanelChannel(message);

  const config = store.getGuildConfig(message.guild.id);
  const roles = (
    await Promise.all(
      config.selfAssignableRoleIds.map((roleId) => message.guild.roles.fetch(roleId)),
    )
  ).filter(Boolean);

  if (!roles.length) {
    throw new UserFacingError(
      "No self-assignable roles are configured. Add one with `s addselfrole @role` first.",
    );
  }

  const buttons = roles.map((role) =>
    new ButtonBuilder()
      .setCustomId(`sukuna:role:${role.id}`)
      .setLabel(role.name.slice(0, 80))
      .setStyle(ButtonStyle.Secondary),
  );
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(buttons.slice(index, index + 5)),
    );
  }

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle("Choose your roles")
    .setDescription("Click a button to add a role. Click it again to remove that role.");

  await message.channel.send({ embeds: [embed], components: rows });
  await reply(message, "Posted the self-assignable role panel.");
}

async function handleConfig(message, store) {
  requirePermission(message, PermissionFlagsBits.ManageGuild, "Manage Server");
  const config = store.getGuildConfig(message.guild.id);
  const roleNames = await Promise.all(
    config.selfAssignableRoleIds.map(async (roleId) => {
      const role = await message.guild.roles.fetch(roleId);
      return role ? role.name : `missing role (${roleId})`;
    }),
  );
  const lines = [
    `Welcome channel: ${config.welcomeChannelId ? `<#${config.welcomeChannelId}>` : "off"}`,
    `Moderation log: ${config.modLogChannelId ? `<#${config.modLogChannelId}>` : "off"}`,
    `Autorole: ${config.autoRoleId ? `<@&${config.autoRoleId}>` : "off"}`,
    `Counting game: ${config.countingChannelId ? `<#${config.countingChannelId}>` : "off"} (current ${config.currentCount}, highest ${config.highestCount})`,
    `Self-assignable roles: ${roleNames.length ? roleNames.join(", ") : "none"}`,
  ];
  await reply(message, lines.join("\n"));
}

export async function handleRoleManagement(message, command, store) {
  switch (command) {
    case "role":
    case "removerole":
      await handleRoleChange(message, command, store);
      return true;
    case "rolepanel":
      await handleRolePanel(message, store);
      return true;
    case "setwelcome":
      await handleWelcomeChannel(message, store);
      return true;
    case "disablewelcome":
      await handleWelcomeChannel(message, store, true);
      return true;
    case "setmodlog":
      await handleModLogChannel(message, store);
      return true;
    case "disablemodlog":
      await handleModLogChannel(message, store, true);
      return true;
    case "setautorole":
      await handleAutorole(message, store);
      return true;
    case "disableautorole":
      await handleAutorole(message, store, true);
      return true;
    case "setcounting":
      await handleCountingSetup(message, store);
      return true;
    case "disablecounting":
      await handleCountingSetup(message, store, true);
      return true;
    case "addselfrole":
    case "removeselfrole":
      await handleSelfRole(message, command, store);
      return true;
    case "config":
      await handleConfig(message, store);
      return true;
    default:
      return false;
  }
}

export async function handleRoleButton(interaction, store) {
  if (!interaction.customId.startsWith("sukuna:role:")) return false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.editReply({ content: "Use this role panel in a server.", ephemeral: true });
      return true;
    }

    const roleId = interaction.customId.slice("sukuna:role:".length);
    const config = store.getGuildConfig(interaction.guild.id);
    if (!config.selfAssignableRoleIds.includes(roleId)) {
      await interaction.editReply({
        content: "That role is no longer available. Ask a moderator to post an updated panel.",
        
      });
      return true;
    }

    const [role, member] = await Promise.all([
      interaction.guild.roles.fetch(roleId),
      interaction.guild.members.fetch(interaction.user.id),
    ]);
    if (!role) throw new UserFacingError("That role no longer exists.");
    const problem = selfAssignableRoleProblem(role);
    if (problem) throw new UserFacingError("That role is not safe to self-assign.");

    const botMember = requireBotPermission(
      interaction.guild,
      PermissionFlagsBits.ManageRoles,
      "Manage Roles",
    );
    if (role.comparePositionTo(botMember.roles.highest) >= 0) {
      throw new UserFacingError("I cannot manage that role. Ask a moderator to check my role order.");
    }

    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, "Member used the Sukuna self-role panel");
      await interaction.editReply({ content: `Removed **${role.name}**.`, ephemeral: true });
    } else {
      await member.roles.add(role, "Member used the Sukuna self-role panel");
      await interaction.editReply({ content: `Added **${role.name}**.`, ephemeral: true });
    }
  } catch (error) {
    if (error instanceof UserFacingError) {
      await interaction.editReply({ content: error.message, ephemeral: true }).catch(() => {});
    } else {
      await sendBotErrorLog(interaction.guild, store, "Role panel button", error);
      await interaction
        .reply({ content: "The role could not be changed. Please try again later.", ephemeral: true })
        .catch(() => {});
    }
  }

  return true;
}
