import { describe, expect, it, vi } from 'vitest';

import {
  CompetitionCancellationService,
  type CompetitionCancellationRepository,
} from '../src/features/competitions/cancel-competition.js';
import { CompetitionCancellationCommandHandler } from '../src/infrastructure/discord/competition-cancellation-command.js';

describe('CompetitionCancellationService', () => {
  it('evaluates competition-manager permission before cancelling', async () => {
    const cancel = vi.fn<CompetitionCancellationRepository['cancel']>().mockResolvedValue({
      kind: 'cancelled',
      competitionId: 'competition-1',
      displayName: 'Fishing',
      guildId: 'guild-1',
    });
    const evaluate = vi.fn().mockResolvedValue({ canManageCompetitions: true });
    const audit = { record: vi.fn() };
    const service = new CompetitionCancellationService({ cancel }, { evaluate }, audit);

    await expect(
      service.cancel({
        competitionId: 'competition-1',
        guildId: 'guild-1',
        hasAdministratorPermission: false,
        memberRoleIds: ['manager-role'],
        requesterDiscordUserId: 'member-1',
      }),
    ).resolves.toMatchObject({ kind: 'cancelled' });

    expect(evaluate).toHaveBeenCalledWith({
      guildId: 'guild-1',
      hasAdministratorPermission: false,
      memberRoleIds: ['manager-role'],
    });
    expect(cancel).toHaveBeenCalledWith({
      canManageCompetitions: true,
      competitionId: 'competition-1',
      guildId: 'guild-1',
      requesterDiscordUserId: 'member-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 'guild-1',
        operation: 'competition.cancelled',
        type: 'competition-lifecycle',
      }),
    );
  });
});

describe('CompetitionCancellationCommandHandler', () => {
  it('paginates choices and binds confirmation to its initiating member', async () => {
    const now = new Date('2026-08-11T12:00:00Z');
    const choices = Array.from({ length: 26 }, (_, index) => ({
      id: `competition-${index}`,
      displayName: `Competition ${index}`,
    }));
    const handler = new CompetitionCancellationCommandHandler(
      { cancel: vi.fn() },
      { listCancellable: vi.fn().mockResolvedValue(choices) },
      () => now,
    );
    const first = await handler.start('guild-1', 'member-1');
    expect(first).toMatchObject({ kind: 'selection', pageCount: 2 });
    if (first.kind !== 'selection') throw new Error('Expected selection');
    expect(first.competitions).toHaveLength(23);
    const second = await handler.choose({
      customId: first.customId,
      competitionId: '__next_page__',
      guildId: 'guild-1',
      requesterDiscordUserId: 'member-1',
    });
    if (second.kind !== 'selection') throw new Error('Expected page');
    expect(second.competitions).toHaveLength(3);
    const confirmation = await handler.choose({
      customId: second.customId,
      competitionId: 'competition-25',
      guildId: 'guild-1',
      requesterDiscordUserId: 'member-1',
    });
    if (confirmation.kind !== 'confirmation') throw new Error('Expected confirmation');
    const denied = await handler.confirm({
      customId: confirmation.customId,
      guildId: 'guild-1',
      requesterDiscordUserId: 'member-2',
      hasAdministratorPermission: false,
      memberRoleIds: [],
    });
    expect(denied.kind).toBe('failed');
    if (denied.kind === 'failed') expect(denied.message).toContain('another member');
  });

  it('rejects an expired confirmation before it can cancel', async () => {
    let now = new Date('2026-08-11T12:00:00Z');
    const cancel = vi.fn();
    const handler = new CompetitionCancellationCommandHandler(
      { cancel },
      {
        listCancellable: vi
          .fn()
          .mockResolvedValue([{ id: 'competition-1', displayName: 'Fishing' }]),
      },
      () => now,
    );
    const selection = await handler.start('guild-1', 'member-1');
    if (selection.kind !== 'selection') throw new Error('Expected selection');
    const confirmation = await handler.choose({
      customId: selection.customId,
      competitionId: 'competition-1',
      guildId: 'guild-1',
      requesterDiscordUserId: 'member-1',
    });
    if (confirmation.kind !== 'confirmation') throw new Error('Expected confirmation');
    now = new Date('2026-08-11T12:06:00Z');
    const expired = await handler.confirm({
      customId: confirmation.customId,
      guildId: 'guild-1',
      requesterDiscordUserId: 'member-1',
      hasAdministratorPermission: false,
      memberRoleIds: [],
    });
    expect(expired).toEqual({
      kind: 'failed',
      message: 'This confirmation expired. Run `/competition cancel` again.',
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});
