import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  EmbedBuilder, MessageFlags, PermissionFlagsBits, PermissionsBitField,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

const state = (store) => {
  store.data.community ??= { afk: {}, reactionPanels: {}, voice: {}, tickets: {} };
  const s = store.data.community;
  s.afk ??= {};
  s.reactionPanels ??= {};
  s.voice ??= {};
  s.tickets ??= {};
  return s;
};

const save = (store) => store.save();

const admin = (m) => {
  const permissions = m.member?.permissions;
  return Boolean(
    permissions?.has(PermissionFlagsBits.Administrator) ||
    permissions?.has(PermissionFlagsBits.ManageGuild)
  );
};

const say = (m, content) => m.reply({
  content,
  allowedMentions: { parse: [], repliedUser: false },
});

const safeName = (s) =>
  String(s).replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 90) || 'room';

export async function handleCommunityCommand(message, command, args, store) {
  const db = state(store);
  const gid = message.guild.id;

  // AFK
  if (command === 'afk') {
    const key = `${gid}:${message.author.id}`;
    const reason = args.join(' ').slice(0, 200) || 'AFK';

    db.afk[key] = { reason, since: Date.now() };
    await save(store);
    await say(message, `AFK enabled: **${reason}**`);
    return true;
  }

  // Reaction Roles
  if (command === 'rr') {
    const sub = (args.shift() || '').toLowerCase();

    if (!['add', 'remove', 'panel', 'list', 'delete'].includes(sub)) {
      await say(message,
        'Usage: `s rr add <panel> @role <label>` · `s rr remove <panel> @role` · `s rr panel <panel> [title]` · `s rr list` · `s rr delete <panel>`'
      );
      return true;
    }

    if (!admin(message)) {
      await say(message, 'You need Manage Server or Administrator to configure reaction roles.');
      return true;
    }

    db.reactionPanels[gid] ??= {};

    if (Array.isArray(db.reactionPanels[gid])) {
      db.reactionPanels[gid] = { general: db.reactionPanels[gid] };
    }

    const panelName = safeName(args[0] || 'general');
    const entries = db.reactionPanels[gid][panelName] ??= [];

    if (sub === 'add' || sub === 'remove') {
      const role = message.mentions.roles.first();

      if (!role) {
        await say(message,
          `Usage: \`s rr ${sub} ${panelName} @role${sub === 'add' ? ' Button label' : ''}\``
        );
        return true;
      }

      if (sub === 'add') {
        const bot = message.guild.members.me;

        const label = args.slice(1)
          .filter(x => !/^<@&?\d+>$/.test(x))
          .join(' ')
          .replace(/^\|\s*/, '')
          .trim() || role.name;

        if (
          !bot?.permissions.has(PermissionFlagsBits.ManageRoles) ||
          role.managed ||
          role.id === gid ||
          role.comparePositionTo(bot.roles.highest) >= 0 ||
          [
            PermissionFlagsBits.Administrator,
            PermissionFlagsBits.ManageGuild,
            PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.KickMembers,
            PermissionFlagsBits.BanMembers,
            PermissionFlagsBits.ModerateMembers,
          ].some(flag => role.permissions.has(flag))
        ) {
          await say(message,
            'That role cannot be assigned by a reaction-role panel. Check bot role order and role permissions.'
          );
          return true;
        }

        if (entries.some(x => x.roleId === role.id)) {
          await say(message, 'That role is already in this panel.');
          return true;
        }

        if (entries.length >= 25) {
          await say(message, 'A panel can contain at most 25 roles.');
          return true;
        }

        entries.push({
          roleId: role.id,
          label: label.slice(0, 80),
        });

        await save(store);
        await say(message,
          `Added **${role.name}** to panel **${panelName}**. Run \`s rr panel ${panelName}\` to publish it.`
        );
        return true;
      }

      db.reactionPanels[gid][panelName] =
        entries.filter(x => x.roleId !== role.id);

      await save(store);
      await say(message,
        `Removed **${role.name}** from panel **${panelName}**.`
      );
      return true;
    }

    if (sub === 'list') {
      const names = Object.entries(db.reactionPanels[gid])
        .filter(([, rows]) => Array.isArray(rows) && rows.length)
        .map(([name, rows]) => `**${name}** (${rows.length} roles)`);

      await say(message,
        names.length ? names.join('\n') : 'No reaction-role panels configured.'
      );
      return true;
    }

    if (sub === 'delete') {
      delete db.reactionPanels[gid][panelName];
      await save(store);
      await say(message, `Deleted panel **${panelName}**.`);
      return true;
    }

    if (!entries.length) {
      await say(message,
        `Panel **${panelName}** is empty. Add roles with \`s rr add ${panelName} @role label\`.`
      );
      return true;
    }

    const embed = new EmbedBuilder()
      .setTitle(args.slice(1).join(' ') || panelName)
      .setDescription('Use the buttons below to add or remove roles.');

    const rows = [];

    for (let i = 0; i < entries.length; i += 5) {
      rows.push(
        new ActionRowBuilder().addComponents(
          entries.slice(i, i + 5).map(x =>
            new ButtonBuilder()
              .setCustomId(`sk:rr:${panelName}:${x.roleId}`)
              .setLabel(x.label)
              .setStyle(ButtonStyle.Secondary)
          )
        )
      );
    }

    await message.channel.send({
      embeds: [embed],
      components: rows,
    });

    await say(message, `Panel **${panelName}** published.`);
    return true;
  }

  // Temporary Voice Rooms
  if (command === 'voice') {
    const sub = (args.shift() || '').toLowerCase();

    if (sub === 'setup') {
      if (!admin(message)) {
        await say(message, 'You need Manage Server or Administrator.');
        return true;
      }

      const memberVoiceChannelId = message.member?.voice?.channelId;
      const memberVoiceChannel = memberVoiceChannelId
        ? await message.guild.channels.fetch(memberVoiceChannelId).catch(() => null)
        : null;
      const lobby =
        message.mentions.channels.first() ||
        memberVoiceChannel;

      if (!lobby || lobby.type !== ChannelType.GuildVoice) {
        await say(message,
          'Join a voice channel first, or mention a voice channel: `s voice setup #VoiceLobby`.'
        );
        return true;
      }

      db.voice[gid] = {
        lobbyId: lobby.id,
        rooms: {},
      };

      await save(store);
      await say(message,
        `Temporary voice-room lobby set to <#${lobby.id}>. Join it to create a room.`
      );
      return true;
    }

    if (sub === 'disable') {
      if (!admin(message)) {
        await say(message, 'You need Manage Server or Administrator.');
        return true;
      }

      const cfg = db.voice[gid];

      if (cfg?.rooms) {
        for (const id of Object.keys(cfg.rooms)) {
          await message.guild.channels.delete(id).catch(() => {});
        }
      }

      delete db.voice[gid];
      await save(store);
      await say(message, 'Temporary voice rooms disabled.');
      return true;
    }

    const roomId = message.member?.voice?.channelId;
    const room = roomId
      ? await message.guild.channels.fetch(roomId).catch(() => null)
      : null;
    const rec = room && db.voice[gid]?.rooms?.[room.id];

    if (!rec || rec.ownerId !== message.author.id) {
      await say(message, 'You must be in a temporary room that you own.');
      return true;
    }

    const action = sub;

    if (action === 'rename') {
      const name = args.join(' ').trim();

      if (!name) {
        await say(message, 'Usage: `s voice rename New Name`');
        return true;
      }

      await room.setName(name.slice(0, 100));
      await say(message, 'Room renamed.');
      return true;
    }

    if (action === 'limit') {
      const n = Number(args[0]);

      if (!Number.isInteger(n) || n < 0 || n > 99) {
        await say(message, 'Usage: `s voice limit 0-99` (0 means unlimited).');
        return true;
      }

      await room.setUserLimit(n);
      await say(message, `Room limit set to ${n || 'unlimited'}.`);
      return true;
    }

    if (['lock', 'unlock', 'hide', 'reveal'].includes(action)) {
      const everyone = message.guild.roles.everyone;

      if (action === 'lock') {
        await room.permissionOverwrites.edit(everyone, { Connect: false });
      }

      if (action === 'unlock') {
        await room.permissionOverwrites.edit(everyone, { Connect: true });
      }

      if (action === 'hide') {
        await room.permissionOverwrites.edit(everyone, { ViewChannel: false });
      }

      if (action === 'reveal') {
        await room.permissionOverwrites.edit(everyone, { ViewChannel: true });
      }

      const result = {
        lock: 'locked',
        unlock: 'unlocked',
        hide: 'hidden',
        reveal: 'visible',
      };

      await say(message, `Room is now ${result[action]}.`);
      return true;
    }

    if (['allow', 'deny', 'kick'].includes(action)) {
      const member = message.mentions.members.first();

      if (!member) {
        await say(message, `Usage: \`s voice ${action} @member\``);
        return true;
      }

      if (action === 'allow') {
        await room.permissionOverwrites.edit(member, {
          ViewChannel: true,
          Connect: true,
        });
      }

      if (action === 'deny') {
        await room.permissionOverwrites.delete(member.id).catch(() => {});
      }

      if (action === 'kick') {
        if (member.voice.channelId !== room.id) {
          await say(message, 'That member is not in your room.');
          return true;
        }

        await member.voice.disconnect('Removed by temporary room owner');
      }

      await say(message, `${member.user.tag}: ${action} complete.`);
      return true;
    }

    await say(message,
      'Voice commands: `s voice setup`, `rename`, `limit`, `lock`, `unlock`, `hide`, `reveal`, `allow @member`, `deny @member`, `kick @member`.'
    );
    return true;
  }

  // Tickets
  if (command === 'ticket') {
    const sub = (args.shift() || '').toLowerCase();

    if (sub === 'setup') {
      if (!admin(message)) {
        await say(message, 'You need Manage Server or Administrator.');
        return true;
      }

      const category = message.mentions.channels.first();
      const transcript = message.mentions.channels
        .filter(c => c.id !== category?.id)
        .first();

      if (
        !category ||
        category.type !== ChannelType.GuildCategory ||
        !transcript?.isTextBased()
      ) {
        await say(message,
          'Usage: `s ticket setup #TicketCategory #TranscriptChannel`'
        );
        return true;
      }

      db.tickets[gid] = {
        categoryId: category.id,
        transcriptId: transcript.id,
        panelChannelId: message.channel.id,
      };

      await save(store);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('sk:ticket:open')
          .setLabel('Open a ticket')
          .setStyle(ButtonStyle.Primary)
      );

      await message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Support')
            .setDescription('Press the button to create a private support ticket.'),
        ],
        components: [row],
      });

      await say(message, 'Ticket panel published and configuration saved.');
      return true;
    }

    if (['claim', 'close', 'reopen', 'delete'].includes(sub)) {
      const cfg = db.tickets[gid];
      const ticket = cfg?.channels?.[message.channel.id];

      if (!ticket) {
        await say(message, 'This channel is not a tracked ticket.');
        return true;
      }

      if (!message.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
        await say(message, 'Staff need Manage Channels for ticket actions.');
        return true;
      }

      if (sub === 'claim') {
        ticket.claimedBy = message.author.id;
        await save(store);
        await say(message, `Ticket claimed by <@${message.author.id}>.`);
        return true;
      }

      if (sub === 'close') {
        const messages = await message.channel.messages.fetch({ limit: 100 });

        const transcript = [...messages.values()]
          .reverse()
          .map(m => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}`)
          .join('\n')
          .slice(0, 180000);

        const log = await message.guild.channels
          .fetch(cfg.transcriptId)
          .catch(() => null);

        if (log?.isTextBased()) {
          await log.send({
            content: `Transcript for ${message.channel.name} (closed by ${message.author.tag})`,
            files: [{
              attachment: Buffer.from(transcript || 'No messages.'),
              name: `${message.channel.name}-transcript.txt`,
            }],
          });
        }

        ticket.closed = true;

        await message.channel.permissionOverwrites.edit(
          ticket.ownerId,
          { SendMessages: false }
        );

        await save(store);
        await say(message, 'Ticket closed and transcript saved.');
        return true;
      }

      if (sub === 'reopen') {
        ticket.closed = false;

        await message.channel.permissionOverwrites.edit(
          ticket.ownerId,
          { ViewChannel: true, SendMessages: true }
        );

        await save(store);
        await say(message, 'Ticket reopened.');
        return true;
      }

      await message.channel.delete('Ticket deleted by staff');
      delete cfg.channels[message.channel.id];
      await save(store);
      return true;
    }

    await say(message,
      'Ticket commands: `s ticket setup #Category #TranscriptChannel`, `claim`, `close`, `reopen`, `delete`.'
    );
    return true;
  }

  return false;
}

export async function handleCommunityInteraction(interaction, store) {
  if (!interaction.isButton() || !interaction.customId?.startsWith('sk:')) {
    return false;
  }

  const parts = interaction.customId.split(':');
  if (!['rr', 'ticket'].includes(parts[1])) return false;

  if (!interaction.inGuild?.() || !interaction.guild) {
    await interaction.reply({
      content: 'Use this button in the server where it was posted.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const db = state(store);
  const gid = interaction.guildId;
  if (parts[1] === 'rr') {
    const panelName = parts[2];
    const roleId = parts[3];

    const panels = db.reactionPanels[gid] || {};
    const allowed = Array.isArray(panels)
      ? panels
      : (panels[panelName] || []);

    if (!allowed.some(x => x.roleId === roleId)) {
      await interaction.editReply({
        content: 'This role button is no longer active.',
      });
      return true;
    }

    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    const bot = interaction.guild.members.me;

    if (
      !role ||
      !bot?.permissions.has(PermissionFlagsBits.ManageRoles) ||
      role.managed ||
      role.comparePositionTo(bot.roles.highest) >= 0 ||
      [
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.ModerateMembers,
      ].some(flag => role.permissions.has(flag))
    ) {
      await interaction.editReply({
        content: 'This role cannot be assigned.',
      });
      return true;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(role);
      await interaction.editReply({
        content: `Removed ${role.name}.`,
      });
    } else {
      await member.roles.add(role);
      await interaction.editReply({
        content: `Added ${role.name}.`,
      });
    }

    return true;
  }

  if (parts[1] === 'ticket' && parts[2] === 'open') {
    const cfg = db.tickets[gid];

    if (!cfg) {
      await interaction.editReply({
        content: 'Tickets are not configured.',
      });
      return true;
    }

    cfg.channels ??= {};

    if (
      Object.values(cfg.channels).some(
        t => t.ownerId === interaction.user.id && !t.closed
      )
    ) {
      await interaction.editReply({
        content: 'You already have an open ticket.',
      });
      return true;
    }

    const channel = await interaction.guild.channels.create({
      name: `ticket-${safeName(interaction.user.username)}`,
      type: ChannelType.GuildText,
      parent: cfg.categoryId,
      permissionOverwrites: [
        {
          id: gid,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: interaction.client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
          ],
        },
        ...interaction.guild.roles.cache
          .filter(r =>
            r.permissions.has(PermissionFlagsBits.ManageChannels) ||
            r.permissions.has(PermissionFlagsBits.Administrator)
          )
          .map(r => ({
            id: r.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          })),
      ],
    });

    cfg.channels[channel.id] = {
      ownerId: interaction.user.id,
      claimedBy: null,
      closed: false,
      createdAt: Date.now(),
    };

    await save(store);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sk:ticket:close')
        .setLabel('Close ticket')
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      content: `<@${interaction.user.id}> Your ticket is open. Staff will assist you.`,
      components: [row],
      allowedMentions: { users: [interaction.user.id] },
    });

    await interaction.editReply({
      content: `Ticket created: ${channel}`,
    });

    return true;
  }

  if (parts[1] === 'ticket' && parts[2] === 'close') {
    const cfg = db.tickets[gid];
    const ticket = cfg?.channels?.[interaction.channelId];

    if (
      !ticket ||
      (
        ticket.ownerId !== interaction.user.id &&
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
      )
    ) {
      await interaction.editReply({
        content: 'Only the ticket owner or staff can close this ticket.',
      });
      return true;
    }

    ticket.closed = true;

    await interaction.channel.permissionOverwrites.edit(
      ticket.ownerId,
      { SendMessages: false }
    );

    await save(store);

    await interaction.editReply({
      content: 'Ticket closed. Staff can reopen or delete it.',
    });

    return true;
  }

  return false;
}

export async function handleCommunityMessage(message, store) {
  if (!message.guild || message.author.bot) return;

  const db = state(store);
  const key = `${message.guild.id}:${message.author.id}`;

  if (db.afk[key]) {
    delete db.afk[key];
    await save(store);

    await message.reply({
      content: 'Welcome back. Your AFK status was removed.',
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
  }

  for (const user of message.mentions.users.values()) {
    const afk = db.afk[`${message.guild.id}:${user.id}`];

    if (afk) {
      await message.reply({
        content: `**${user.username}** is AFK: ${afk.reason}`,
        allowedMentions: {
          parse: [],
          repliedUser: false,
        },
      }).catch(() => {});
    }
  }
}

export async function handleCommunityVoiceState(oldState, newState, store) {
  const db = state(store);
  const guild = newState.guild || oldState.guild;
  const cfg = db.voice[guild.id];

  if (!cfg) return;

  const oldChannel = oldState.channelId
    ? await guild.channels.fetch(oldState.channelId).catch(() => null)
    : null;
  const newChannel = newState.channelId
    ? await guild.channels.fetch(newState.channelId).catch(() => null)
    : null;

  if (
    oldState.channelId &&
    cfg.rooms?.[oldState.channelId] &&
    (!oldChannel || oldChannel.members.size === 0)
  ) {
    if (oldChannel) {
      await oldChannel.delete('Temporary room is empty').catch(() => {});
    }
    delete cfg.rooms[oldState.channelId];
    await save(store);
  }

  if (newState.channelId !== cfg.lobbyId) return;

  const member =
    newState.member ??
    (newState.id ? await guild.members.fetch(newState.id).catch(() => null) : null);
  if (!member || !newChannel) return;

  const room = await guild.channels.create({
    name: `${safeName(member.user.username)}'s-room`,
    type: ChannelType.GuildVoice,
    parent: newChannel.parentId || undefined,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
        ],
      },
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ],
  });

  cfg.rooms ??= {};
  cfg.rooms[room.id] = {
    ownerId: member.id,
    createdAt: Date.now(),
  };

  await save(store);

  await member.voice.setChannel(room).catch(async () => {
    await room.delete().catch(() => {});
    delete cfg.rooms[room.id];
    await save(store);
  });
}
