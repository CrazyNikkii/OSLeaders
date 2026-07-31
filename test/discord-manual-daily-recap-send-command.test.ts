import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { ManualDailyRecapSendResult } from '../src/features/recaps/send-daily-recap.js';
import { DiscordManualDailyRecapSendCommandAdapter } from '../src/infrastructure/discord/manual-daily-recap-send-command.js';

describe('Discord manual daily recap send command', () => {
  it('adds the recap send subcommand beside the private preview', async () => {
    const { dailyRecapPreviewCommandDefinitions } =
      await import('../src/infrastructure/discord/daily-recap-preview-command.js');

    const definition = JSON.stringify(dailyRecapPreviewCommandDefinitions[0]);
    expect(definition).toContain('"name":"preview"');
    expect(definition).toContain('"name":"send"');
    expect(definition).toContain('after confirmation');
  });

  it('requires administrator-or-bot-manager authorization before issuing a bound confirmation', async () => {
    const sends = new ManualSendStub();
    const permissions = new PermissionStub(false);
    const adapter = new DiscordManualDailyRecapSendCommandAdapter(sends, permissions);
    const responses = commandResponses();

    await adapter.handle(commandInteraction(responses) as never);

    expect(sends.guildIds).toEqual([]);
    expect(responses.reply).toHaveBeenCalledWith({
      content: 'You need Discord Administrator permission or the bot-manager role to send a recap.',
      flags: MessageFlags.Ephemeral,
    });
    expect(permissions.requests).toEqual([
      { guildId: 'guild-one', hasAdministratorPermission: false, memberRoleIds: [] },
    ]);
  });

  it('confirms only for the initiating authorized member, then persists a pending delivery', async () => {
    const sends = new ManualSendStub({
      kind: 'ready_for_delivery',
      recapChannelId: 'recap-channel',
      recapRunId: 'run-one',
    });
    const permissions = new PermissionStub(true);
    const adapter = new DiscordManualDailyRecapSendCommandAdapter(sends, permissions);
    const commandResponses = commandResponse();

    await adapter.handle(
      commandInteraction(commandResponses, { memberRoleIds: ['bot-manager-role'] }) as never,
    );

    const customId = confirmationCustomId(firstReply(commandResponses));
    expect(permissions.requests[0]).toEqual({
      guildId: 'guild-one',
      hasAdministratorPermission: false,
      memberRoleIds: ['bot-manager-role'],
    });
    const rejectedResponses = buttonResponses();
    await adapter.handle(
      buttonInteraction(customId, rejectedResponses, { userId: 'member-two' }) as never,
    );
    expect(sends.guildIds).toEqual([]);
    expect(rejectedResponses.reply).toHaveBeenCalledWith({
      content: 'You are not allowed to use this recap-send confirmation.',
      flags: MessageFlags.Ephemeral,
    });

    const confirmationResponses = buttonResponses();
    await adapter.handle(buttonInteraction(customId, confirmationResponses) as never);

    expect(sends.guildIds).toEqual(['guild-one']);
    expect(confirmationResponses.deferUpdate).toHaveBeenCalledOnce();
    expect(confirmationResponses.editReply).toHaveBeenCalledWith({
      components: [],
      content:
        'Daily recap collected and saved for delivery to <#recap-channel>. Discord delivery will be added in a later update.',
    });
  });

  it('expires confirmations without invoking the baseline-advancing workflow', async () => {
    const now = new Date('2026-07-31T10:00:00.000Z');
    const clock = { now: () => now };
    const sends = new ManualSendStub();
    const adapter = new DiscordManualDailyRecapSendCommandAdapter(
      sends,
      new PermissionStub(true),
      clock,
    );
    const commandResponses = commandResponse();
    await adapter.handle(commandInteraction(commandResponses) as never);

    now.setMinutes(now.getMinutes() + 5);
    const responses = buttonResponses();
    await adapter.handle(
      buttonInteraction(confirmationCustomId(firstReply(commandResponses)), responses) as never,
    );

    expect(sends.guildIds).toEqual([]);
    expect(responses.reply).toHaveBeenCalledWith({
      content: 'This recap-send confirmation has expired. Run `/recap send` again.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('does not allow direct-message invocation', async () => {
    const sends = new ManualSendStub();
    const adapter = new DiscordManualDailyRecapSendCommandAdapter(sends, new PermissionStub(true));
    const responses = commandResponse();

    await adapter.handle(commandInteraction(responses, { guildId: null }) as never);

    expect(sends.guildIds).toEqual([]);
    expect(responses.reply).toHaveBeenCalledWith({
      content: 'This command can only be used in a Discord server.',
      flags: MessageFlags.Ephemeral,
    });
  });
});

class ManualSendStub {
  public readonly guildIds: string[] = [];

  public constructor(
    private readonly result:
      | Omit<
          Extract<ManualDailyRecapSendResult, { kind: 'ready_for_delivery' }>,
          'collection' | 'presentation'
        >
      | ManualDailyRecapSendResult = {
      kind: 'recap_not_configured',
    },
  ) {}

  public send(guildId: string): Promise<ManualDailyRecapSendResult> {
    this.guildIds.push(guildId);
    return Promise.resolve(this.result as ManualDailyRecapSendResult);
  }
}

class PermissionStub {
  public readonly requests: {
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }[] = [];

  public constructor(private readonly canManageAccounts: boolean) {}

  public evaluate(request: {
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }) {
    this.requests.push(request);
    return Promise.resolve({
      canManageAccounts: this.canManageAccounts,
      canManageCompetitions: false,
    });
  }
}

function commandInteraction(
  responses: ReturnType<typeof commandResponse>,
  options: { guildId?: string | null; memberRoleIds?: readonly string[]; userId?: string } = {},
) {
  return {
    commandName: 'recap',
    guildId: options.guildId === undefined ? 'guild-one' : options.guildId,
    isChatInputCommand: () => true,
    member: { roles: options.memberRoleIds ?? [] },
    memberPermissions: { has: () => false },
    options: { getSubcommand: () => 'send' },
    user: { id: options.userId ?? 'member-one' },
    ...responses,
  };
}

function buttonInteraction(
  customId: string,
  responses: ReturnType<typeof buttonResponses>,
  options: { guildId?: string | null; userId?: string } = {},
) {
  return {
    customId,
    guildId: options.guildId === undefined ? 'guild-one' : options.guildId,
    isButton: () => true,
    isChatInputCommand: () => false,
    member: { roles: [] },
    memberPermissions: { has: () => false },
    user: { id: options.userId ?? 'member-one' },
    ...responses,
  };
}

function commandResponse() {
  return { reply: vi.fn(() => Promise.resolve()) };
}

function commandResponses() {
  return commandResponse();
}

function buttonResponses() {
  return {
    deferUpdate: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
  };
}

function confirmationCustomId(response: unknown): string {
  const customId = (
    response as { components?: { components?: { data?: { custom_id?: string } }[] }[] }
  ).components?.[0]?.components?.[0]?.data?.custom_id;
  if (customId === undefined) {
    throw new Error('Expected a confirmation button.');
  }
  return customId;
}

function firstReply(responses: ReturnType<typeof commandResponse>): unknown {
  return (responses.reply.mock.calls as unknown as [unknown][])[0]?.[0];
}
