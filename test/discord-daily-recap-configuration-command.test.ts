import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { ConfigureDailyRecapResult } from '../src/features/recaps/configure-daily-recap.js';
import { DiscordDailyRecapConfigurationCommandAdapter } from '../src/infrastructure/discord/daily-recap-configuration-command.js';

describe('Discord daily recap configuration command', () => {
  it('passes guild-scoped permission and configuration inputs, then confirms privately', async () => {
    const configure = vi.fn(() => Promise.resolve(configured()));
    const adapter = new DiscordDailyRecapConfigurationCommandAdapter({ configure });
    const reply = vi.fn(() => Promise.resolve());

    await adapter.handle(interaction(reply) as never);

    expect(configure).toHaveBeenCalledWith({
      enabled: true,
      guildId: 'guild-one',
      hasAdministratorPermission: true,
      memberRoleIds: ['bot-manager'],
      recapChannelId: 'recap-channel',
      recapLocalTime: '18:00',
      timezone: 'Europe/Helsinki',
    });
    expect(reply).toHaveBeenCalledWith({
      content:
        'Automatic daily recaps are enabled for <#recap-channel> at 18:00 (Europe/Helsinki).',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('keeps direct messages private without calling the configuration service', async () => {
    const configure = vi.fn(() => Promise.resolve(configured()));
    const adapter = new DiscordDailyRecapConfigurationCommandAdapter({ configure });
    const reply = vi.fn(() => Promise.resolve());

    await adapter.handle(interaction(reply, { guildId: null }) as never);

    expect(configure).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: 'This command can only be used in a Discord server.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('translates authorization and validation outcomes', async () => {
    for (const [result, message] of [
      [
        { kind: 'forbidden' },
        'You need Discord Administrator permission or the bot-manager role to configure daily recaps.',
      ],
      [
        { kind: 'invalid_local_time' },
        'Use an unambiguous daily local time in HH:mm format; daylight-saving transition times are not supported.',
      ],
      [{ kind: 'invalid_timezone' }, 'Use a valid IANA timezone, for example Europe/Helsinki.'],
    ] as const) {
      const configure = vi.fn(() => Promise.resolve(result));
      const adapter = new DiscordDailyRecapConfigurationCommandAdapter({ configure });
      const reply = vi.fn(() => Promise.resolve());

      await adapter.handle(interaction(reply) as never);
      expect(reply).toHaveBeenCalledWith({ content: message, flags: MessageFlags.Ephemeral });
    }
  });
});

function interaction(reply: ReturnType<typeof vi.fn>, overrides: { guildId?: string | null } = {}) {
  return {
    commandName: 'recap',
    guildId: 'guild-one',
    member: { roles: { cache: new Map([['bot-manager', {}]]) } },
    memberPermissions: {
      has: (permission: bigint) => permission === PermissionFlagsBits.Administrator,
    },
    options: {
      getBoolean: () => true,
      getChannel: () => ({ id: 'recap-channel' }),
      getString: (name: string) => (name === 'time' ? '18:00' : 'Europe/Helsinki'),
      getSubcommand: () => 'configure',
    },
    reply,
    ...overrides,
  };
}

function configured(): ConfigureDailyRecapResult {
  return {
    configuration: {
      administrativeLogChannelId: null,
      administrativeLogMode: 'standard',
      botManagerRoleId: null,
      competitionManagerRoleId: null,
      guildId: 'guild-one',
      modeEmojis: {},
      recapChannelId: 'recap-channel',
      recapEnabled: true,
      recapLocalTime: '18:00',
      timezone: 'Europe/Helsinki',
    },
    kind: 'configured',
  };
}
