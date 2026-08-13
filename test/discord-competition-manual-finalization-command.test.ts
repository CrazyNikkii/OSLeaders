import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type {
  ManualTimedCompetitionFinalizationResult,
  TimedCompetitionFinalizationPermissionEvaluator,
} from '../src/features/competitions/finalize-timed-competition.js';
import {
  CompetitionManualFinalizationCommandHandler,
  DiscordCompetitionManualFinalizationCommandAdapter,
} from '../src/infrastructure/discord/competition-manual-finalization-command.js';

describe('Discord manual timed competition finalization command', () => {
  it('binds selection and confirmation to the initiating member and guild', async () => {
    const finalizations = new Finalizations();
    const handler = new CompetitionManualFinalizationCommandHandler(
      finalizations,
      new Choices(),
      permissions,
    );
    const selection = await handler.start('guild-one', 'creator-one');
    if (selection.kind !== 'selection') throw new Error('Expected a selection.');
    await expect(
      handler.choose({
        competitionId: 'competition-one',
        customId: selection.customId,
        guildId: 'guild-two',
        requesterDiscordUserId: 'creator-one',
      }),
    ).resolves.toMatchObject({ message: 'This interaction belongs to another member or server.' });

    const replacement = await handler.start('guild-one', 'creator-one');
    if (replacement.kind !== 'selection') throw new Error('Expected a selection.');
    const confirmation = await handler.choose({
      competitionId: 'competition-one',
      customId: replacement.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'creator-one',
    });
    if (confirmation.kind !== 'confirmation') throw new Error('Expected confirmation.');
    const confirmed = await handler.confirm({
      customId: confirmation.customId,
      guildId: 'guild-one',
      hasAdministratorPermission: false,
      memberRoleIds: [],
      requesterDiscordUserId: 'creator-one',
    });
    expect(confirmed.kind).toBe('failed');
    expect(confirmed.message).toContain('Competition final values were collected');
    expect(finalizations.requests).toEqual([
      expect.objectContaining({ competitionId: 'competition-one', guildId: 'guild-one' }),
    ]);
  });

  it('keeps the command response private and confirms before fresh collection', async () => {
    const order: string[] = [];
    const handler = new CompetitionManualFinalizationCommandHandler(
      new Finalizations(() => order.push('finalize')),
      new Choices(),
      permissions,
    );
    const adapter = new DiscordCompetitionManualFinalizationCommandAdapter(handler);
    const reply = vi.fn(() => Promise.resolve());
    await adapter.handle({
      commandName: 'competition',
      guildId: 'guild-one',
      isChatInputCommand: () => true,
      options: { getSubcommand: () => 'finish' },
      reply,
      user: { id: 'creator-one' },
    } as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));

    const selection = await handler.start('guild-one', 'creator-one');
    if (selection.kind !== 'selection') throw new Error('Expected a selection.');
    const confirmation = await handler.choose({
      competitionId: 'competition-one',
      customId: selection.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'creator-one',
    });
    if (confirmation.kind !== 'confirmation') throw new Error('Expected confirmation.');
    const deferUpdate = vi.fn(() => {
      order.push('defer');
      return Promise.resolve();
    });
    const editReply = vi.fn(() => {
      order.push('edit');
      return Promise.resolve();
    });
    await adapter.handle({
      customId: confirmation.customId,
      deferUpdate,
      editReply,
      guildId: 'guild-one',
      isButton: () => true,
      isChatInputCommand: () => false,
      isStringSelectMenu: () => false,
      member: null,
      memberPermissions: { has: () => false },
      user: { id: 'creator-one' },
    } as never);
    expect(order).toEqual(['defer', 'finalize', 'edit']);
  });
});

const permissions: TimedCompetitionFinalizationPermissionEvaluator = {
  evaluate: () => Promise.resolve({ canManageCompetitions: false }),
};

class Choices {
  public listManuallyFinalizable() {
    return Promise.resolve([{ displayName: 'Mining week', id: 'competition-one' }]);
  }
}

class Finalizations {
  public readonly requests: Record<string, unknown>[] = [];
  public constructor(private readonly onFinalize: () => void = () => undefined) {}
  public finalizeManually(
    request: Record<string, unknown>,
  ): Promise<ManualTimedCompetitionFinalizationResult> {
    this.onFinalize();
    this.requests.push(request);
    return Promise.resolve({
      competitionId: 'competition-one',
      guildId: 'guild-one',
      isResultDelayed: false,
      kind: 'finished',
      winnerEntrantIds: ['entrant-one'],
    });
  }
}
