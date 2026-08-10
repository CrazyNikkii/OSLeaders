import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { CompetitionStandingsResult } from '../src/features/competitions/competition-standings.js';
import {
  CompetitionStandingsCommandHandler,
  DiscordCompetitionStandingsCommandAdapter,
  competitionStandingsEmbeds,
  type CompetitionStandingsChoices,
} from '../src/infrastructure/discord/competition-standings-command.js';

describe('Discord competition standings command', () => {
  it('binds the active-competition selection to its initiating member and guild', async () => {
    const standings = new Standings();
    const handler = new CompetitionStandingsCommandHandler(standings, new Choices());
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
    ).resolves.toMatchObject({ kind: 'standings' });
    expect(standings.requests).toEqual([
      { competitionId: 'competition-one', guildId: 'guild-one' },
    ]);
  });

  it('paginates active competition choices within Discord limits', async () => {
    const handler = new CompetitionStandingsCommandHandler(
      new Standings(),
      new Choices(
        Array.from({ length: 24 }, (_, index) => ({
          displayName: `Competition ${index + 1}`,
          id: `competition-${index + 1}`,
        })),
      ),
    );
    const first = await handler.start('guild-one', 'member-one');
    if (first.kind !== 'competition_selection') throw new Error('Expected selection.');
    expect(first.competitions).toHaveLength(23);

    const second = await handler.selectCompetition({
      competitionId: '__next_page__',
      customId: first.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'member-one',
    });
    expect(second).toMatchObject({
      competitions: [{ id: 'competition-24' }],
      kind: 'competition_selection',
    });
  });

  it('acknowledges selection before fresh standings collection and publishes results publicly', async () => {
    const order: string[] = [];
    const handler = new CompetitionStandingsCommandHandler(
      new Standings(standings(), () => order.push('standings')),
      new Choices(),
    );
    const selection = await handler.start('guild-one', 'member-one');
    if (selection.kind !== 'competition_selection') throw new Error('Expected selection.');
    const adapter = new DiscordCompetitionStandingsCommandAdapter(handler);
    const deferUpdate = vi.fn(() => {
      order.push('defer');
      return Promise.resolve();
    });
    const deleteReply = vi.fn(() => {
      order.push('delete');
      return Promise.resolve();
    });
    const send = vi.fn(() => {
      order.push('send');
      return Promise.resolve();
    });

    await adapter.handle({
      channel: { isSendable: () => true, send },
      customId: selection.customId,
      deferUpdate,
      deleteReply,
      editReply: vi.fn(() => Promise.resolve()),
      guildId: 'guild-one',
      isChatInputCommand: () => false,
      isStringSelectMenu: () => true,
      user: { id: 'member-one' },
      values: ['competition-one'],
    } as never);

    expect(order).toEqual(['defer', 'standings', 'send', 'delete']);
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps selection private and renders totals, account detail, deadline, and stale warning', async () => {
    const handler = new CompetitionStandingsCommandHandler(new Standings(), new Choices());
    const adapter = new DiscordCompetitionStandingsCommandAdapter(handler);
    const reply = vi.fn(() => Promise.resolve());

    await adapter.handle({
      commandName: 'competition',
      guildId: 'guild-one',
      isChatInputCommand: () => true,
      options: { getSubcommand: () => 'standings' },
      reply,
      user: { id: 'member-one' },
    } as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));

    const [embed] = competitionStandingsEmbeds(standings());
    if (embed === undefined) throw new Error('Expected a standings embed.');
    expect(embed.data.description).toContain('Ends <t:');
    expect(embed.data.description).toContain('+50');
    expect(embed.data.description).toContain('Alpha');
    expect(embed.data.description).toContain('score may be incomplete');
  });
});

class Choices implements CompetitionStandingsChoices {
  public constructor(
    private readonly competitions = [{ displayName: 'Mining week', id: 'competition-one' }],
  ) {}
  public listActive(): Promise<readonly { displayName: string; id: string }[]> {
    return Promise.resolve(this.competitions);
  }
}

class Standings {
  public readonly requests: { competitionId: string; guildId: string }[] = [];
  public constructor(
    private readonly result: Extract<
      CompetitionStandingsResult,
      { kind: 'standings' }
    > = standings(),
    private readonly collected: () => void = () => undefined,
  ) {}
  public getStandings(request: { competitionId: string; guildId: string }) {
    this.collected();
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

function standings(): Extract<CompetitionStandingsResult, { kind: 'standings' }> {
  return {
    competitionId: 'competition-one',
    endsAt: new Date('2026-08-10T16:00:00.000Z'),
    entries: [
      {
        accounts: [
          {
            currentValue: 150n,
            displayUsername: 'Alpha',
            gain: 50n,
            id: 'account-one',
            isCurrentValueStale: true,
            startingValue: 100n,
          },
        ],
        discordUserId: 'member-one',
        entrantId: 'entrant-one',
        gain: 50n,
        isPotentiallyIncomplete: true,
        rank: 1,
      },
    ],
    failures: [{ accountId: 'account-one', failure: { kind: 'timeout' } }],
    kind: 'standings',
    metric: { kind: 'skill', name: 'Mining' },
    targetValue: null,
  };
}
