import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { CompetitionStartResult } from '../src/features/competitions/start-competition.js';
import {
  CompetitionStartCommandHandler,
  DiscordCompetitionStartCommandAdapter,
  type CompetitionStartChoices,
} from '../src/infrastructure/discord/competition-start-command.js';

describe('Discord competition start command', () => {
  it('binds the start selection to the initiating member and guild', async () => {
    const service = new Starts();
    const handler = new CompetitionStartCommandHandler(service, new Choices());
    const selection = await handler.start('guild-one', 'manager-one');
    if (selection.kind !== 'competition_selection')
      throw new Error('Expected competition selection.');

    await expect(
      handler.selectCompetition({
        competitionId: 'competition-one',
        customId: selection.customId,
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: [],
        requesterDiscordUserId: 'manager-two',
      }),
    ).resolves.toMatchObject({ message: 'This interaction belongs to another member or server.' });

    await expect(
      handler.selectCompetition({
        competitionId: 'competition-one',
        customId: selection.customId,
        guildId: 'guild-one',
        hasAdministratorPermission: true,
        memberRoleIds: ['competition-manager'],
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toMatchObject({ message: 'Competition started.' });
    expect(service.requests).toEqual([
      expect.objectContaining({
        competitionId: 'competition-one',
        guildId: 'guild-one',
        hasAdministratorPermission: true,
        memberRoleIds: ['competition-manager'],
        requesterDiscordUserId: 'manager-one',
      }),
    ]);
  });

  it('shows only startable competitions, paginates them, and reports pending fetch failures', async () => {
    const choices = new Choices(
      Array.from({ length: 26 }, (_, index) => ({
        displayName: `Competition ${index + 1}`,
        id: `competition-${index + 1}`,
      })),
    );
    const service = new Starts({
      kind: 'start_pending',
      competitionId: 'competition-24',
      guildId: 'guild-one',
      failures: [
        {
          account: { displayUsername: 'Rune Scape' },
          failure: { kind: 'temporary_upstream_failure' },
        },
      ],
    } as unknown as CompetitionStartResult);
    const handler = new CompetitionStartCommandHandler(service, choices);
    const first = await handler.start('guild-one', 'manager-one');
    if (first.kind !== 'competition_selection') throw new Error('Expected competition selection.');
    expect(first.competitions).toHaveLength(23);

    const second = await handler.selectCompetition({
      competitionId: '__next_page__',
      customId: first.customId,
      guildId: 'guild-one',
      hasAdministratorPermission: false,
      memberRoleIds: [],
      requesterDiscordUserId: 'manager-one',
    });
    if (second.kind !== 'competition_selection')
      throw new Error('Expected paged competition selection.');
    expect(second.competitions[0]?.id).toBe('competition-24');

    await expect(
      handler.selectCompetition({
        competitionId: 'competition-24',
        customId: second.customId,
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: [],
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toMatchObject({
      message:
        'Competition start is pending because starting values could not be fetched for: **Rune Scape**.',
    });
  });

  it('keeps command and selection responses private', async () => {
    const handler = new CompetitionStartCommandHandler(new Starts(), new Choices());
    const adapter = new DiscordCompetitionStartCommandAdapter(handler);
    const reply = vi.fn(() => Promise.resolve());

    await adapter.handle({
      commandName: 'competition',
      guildId: 'guild-one',
      isChatInputCommand: () => true,
      options: { getSubcommand: () => 'start' },
      reply,
      user: { id: 'manager-one' },
    } as never);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Choose a competition to start.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  it('acknowledges a component selection before starting fresh Hiscores work', async () => {
    const order: string[] = [];
    const service = new Starts(undefined, () => order.push('start'));
    const handler = new CompetitionStartCommandHandler(service, new Choices());
    const selection = await handler.start('guild-one', 'manager-one');
    if (selection.kind !== 'competition_selection')
      throw new Error('Expected competition selection.');
    const adapter = new DiscordCompetitionStartCommandAdapter(handler);
    const deferUpdate = vi.fn(() => {
      order.push('defer');
      return Promise.resolve();
    });
    const editReply = vi.fn(() => {
      order.push('edit');
      return Promise.resolve();
    });

    await adapter.handle({
      customId: selection.customId,
      deferUpdate,
      editReply,
      guildId: 'guild-one',
      isChatInputCommand: () => false,
      isStringSelectMenu: () => true,
      member: null,
      memberPermissions: { has: () => false },
      user: { id: 'manager-one' },
      values: ['competition-one'],
    } as never);

    expect(order).toEqual(['defer', 'start', 'edit']);
  });
});

class Choices implements CompetitionStartChoices {
  public constructor(
    private readonly competitions = [{ displayName: 'Mining week', id: 'competition-one' }],
  ) {}

  public listStartable() {
    return Promise.resolve(this.competitions);
  }
}

class Starts {
  public readonly requests: Record<string, unknown>[] = [];

  public constructor(
    private readonly result: CompetitionStartResult = started(),
    private readonly onStart: () => void = () => undefined,
  ) {}

  public start(request: Record<string, unknown>): Promise<CompetitionStartResult> {
    this.onStart();
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

function started(): CompetitionStartResult {
  return {
    competitionId: 'competition-one',
    endsAt: null,
    guildId: 'guild-one',
    kind: 'started',
    startedAt: new Date('2026-08-10T12:00:00.000Z'),
  };
}
