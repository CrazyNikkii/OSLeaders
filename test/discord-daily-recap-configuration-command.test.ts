import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { ConfigureDailyRecapResult } from '../src/features/recaps/configure-daily-recap.js';
import { DiscordDailyRecapConfigurationCommandAdapter } from '../src/infrastructure/discord/daily-recap-configuration-command.js';

describe('Discord daily recap configuration command', () => {
  it('privately defers before configuration work, then confirms the guild-scoped result', async () => {
    const configure = vi.fn(() => Promise.resolve(configured()));
    const adapter = new DiscordDailyRecapConfigurationCommandAdapter({ configure });
    const responses = responseMethods();

    await adapter.handle(interaction(responses) as never);

    expect(responses.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(configure).toHaveBeenCalledWith({
      enabled: true,
      guildId: 'guild-one',
      hasAdministratorPermission: true,
      memberRoleIds: ['bot-manager'],
      recapChannelId: 'recap-channel',
      recapLocalTime: '18:00',
      timezone: 'Europe/Helsinki',
    });
    expect(responses.editReply).toHaveBeenCalledWith({
      content:
        'Automatic daily recaps are enabled for <#recap-channel> at 18:00 (Europe/Helsinki).',
    });
  });

  it('acknowledges before slow configuration work begins', async () => {
    let resolveConfiguration: ((result: ConfigureDailyRecapResult) => void) | undefined;
    const responses = responseMethods();
    const configure = vi.fn(() => {
      expect(responses.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      return new Promise<ConfigureDailyRecapResult>((resolve) => {
        resolveConfiguration = resolve;
      });
    });
    const adapter = new DiscordDailyRecapConfigurationCommandAdapter({ configure });

    const handling = adapter.handle(interaction(responses) as never);

    await vi.waitFor(() => expect(responses.deferReply).toHaveBeenCalledOnce());
    expect(configure).toHaveBeenCalledOnce();
    expect(responses.editReply).not.toHaveBeenCalled();
    resolveConfiguration?.(configured());
    await handling;
  });

  it('keeps direct messages private without calling the configuration service', async () => {
    const configure = vi.fn(() => Promise.resolve(configured()));
    const adapter = new DiscordDailyRecapConfigurationCommandAdapter({ configure });
    const responses = responseMethods();

    await adapter.handle(interaction(responses, { guildId: null }) as never);

    expect(configure).not.toHaveBeenCalled();
    expect(responses.deferReply).not.toHaveBeenCalled();
    expect(responses.reply).toHaveBeenCalledWith({
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
      const responses = responseMethods();

      await adapter.handle(interaction(responses) as never);
      expect(responses.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(responses.editReply).toHaveBeenCalledWith({ content: message });
    }
  });
});

function interaction(
  responses: ReturnType<typeof responseMethods>,
  overrides: { guildId?: string | null } = {},
) {
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
    ...responses,
    ...overrides,
  };
}

function responseMethods() {
  return {
    deferReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
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
