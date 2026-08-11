import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { CompetitionResultsHistoryResult } from '../src/features/competitions/competition-results-history.js';
import {
  CompetitionResultsHistoryCommandHandler,
  DiscordCompetitionResultsHistoryCommandAdapter,
  competitionResultsHistoryChoiceLabel,
  competitionResultsHistoryEmbeds,
  competitionResultsHistoryTitle,
} from '../src/infrastructure/discord/competition-results-history-command.js';

describe('Discord competition results history command', () => {
  it('binds history selection to the initiating member and guild', async () => {
    const history = new History();
    const handler = new CompetitionResultsHistoryCommandHandler(history);
    const selection = await handler.start('guild-one', 'member-one');
    if (selection.kind !== 'competition_selection') throw new Error('Expected selection.');

    await expect(
      handler.selectCompetition({
        competitionId: 'competition-one',
        customId: selection.customId,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-two',
      }),
    ).resolves.toMatchObject({ message: 'This interaction belongs to another member or server.' });
    await expect(
      handler.selectCompetition({
        competitionId: 'competition-one',
        customId: selection.customId,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toMatchObject({ kind: 'finished_result' });
    expect(history.requests).toEqual([{ competitionId: 'competition-one', guildId: 'guild-one' }]);
  });

  it('keeps the selection private and publishes rendered results publicly', async () => {
    const handler = new CompetitionResultsHistoryCommandHandler(new History());
    const adapter = new DiscordCompetitionResultsHistoryCommandAdapter(handler);
    const reply = vi.fn(() => Promise.resolve());
    await adapter.handle({
      commandName: 'competition',
      guildId: 'guild-one',
      isChatInputCommand: () => true,
      options: { getSubcommand: () => 'history' },
      reply,
      user: { id: 'member-one' },
    } as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));

    const selection = await handler.start('guild-one', 'member-one');
    if (selection.kind !== 'competition_selection') throw new Error('Expected selection.');
    const send = vi.fn(() => Promise.resolve());
    await adapter.handle({
      channel: { isSendable: () => true, send },
      customId: selection.customId,
      deferUpdate: vi.fn(() => Promise.resolve()),
      deleteReply: vi.fn(() => Promise.resolve()),
      editReply: vi.fn(() => Promise.resolve()),
      guildId: 'guild-one',
      isChatInputCommand: () => false,
      isStringSelectMenu: () => true,
      user: { id: 'member-one' },
      values: ['competition-one'],
    } as never);
    expect(send).toHaveBeenCalledOnce();
  });

  it('renders immutable account values, shared winners, and delayed-result warning', () => {
    const [embed] = competitionResultsHistoryEmbeds(result());
    if (embed === undefined) throw new Error('Expected result embed.');
    expect(embed.data.description).toContain('Alpha');
    expect(embed.data.description).toContain('Ironman');
    expect(embed.data.description).toContain('Winner');
    expect(embed.data.footer?.text).toContain('after the deadline');
  });

  it('bounds long competition names for Discord option labels and embed titles', () => {
    const displayName = 'x'.repeat(300);
    expect(competitionResultsHistoryChoiceLabel(displayName)).toHaveLength(100);
    expect(competitionResultsHistoryChoiceLabel(displayName).endsWith('…')).toBe(true);
    expect(competitionResultsHistoryTitle(displayName, ' (12/12)')).toHaveLength(256);
    expect(
      competitionResultsHistoryTitle(displayName, ' (12/12)').endsWith(' results (12/12)'),
    ).toBe(true);
  });
});

class History {
  public readonly requests: { competitionId: string; guildId: string }[] = [];
  public listFinished() {
    return Promise.resolve([{ displayName: 'Mining week', id: 'competition-one' }]);
  }
  public getFinishedResult(request: { competitionId: string; guildId: string }) {
    this.requests.push(request);
    return Promise.resolve(result());
  }
}

function result(): Extract<CompetitionResultsHistoryResult, { kind: 'finished_result' }> {
  return {
    competitionId: 'competition-one',
    displayName: 'Mining week',
    finishedAt: new Date('2026-08-10T16:00:00.000Z'),
    isResultDelayed: true,
    kind: 'finished_result',
    metric: { kind: 'skill', name: 'Mining' },
    targetValue: null,
    entries: [
      {
        accounts: [
          {
            accountMode: 'ironman',
            displayUsername: 'Alpha',
            finalValue: 150n,
            gain: 50n,
            startingValue: 100n,
          },
        ],
        discordUserId: 'member-one',
        entrantId: 'entrant-one',
        finalGain: 50n,
        isWinner: true,
        rank: 1,
      },
    ],
  };
}
