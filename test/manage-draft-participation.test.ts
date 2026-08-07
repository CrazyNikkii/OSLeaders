import { describe, expect, it } from 'vitest';

import {
  CompetitionDraftParticipationService,
  type CompetitionDraftParticipationRepository,
  type CompetitionEntrant,
  type CompetitionParticipationResult,
} from '../src/features/competitions/manage-draft-participation.js';

describe('competition draft participation service', () => {
  it('allows a present member to join a draft with their selected linked accounts', async () => {
    const repository = new ParticipationRepository();
    const service = new CompetitionDraftParticipationService(
      repository,
      permissions(true),
      () => 'entrant-one',
    );

    await expect(
      service.join({
        competitionId: 'competition-one',
        contributingAccountIds: ['account-one', 'account-two'],
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        requesterIsPresent: true,
      }),
    ).resolves.toMatchObject({
      kind: 'joined',
      entrant: {
        discordUserId: 'member-one',
        contributingAccountIds: ['account-one', 'account-two'],
      },
    });
  });

  it('rejects self-joins by absent members and empty or duplicate account selections', async () => {
    const repository = new ParticipationRepository();
    const service = new CompetitionDraftParticipationService(
      repository,
      permissions(true),
      () => 'entrant-one',
    );

    await expect(
      service.join({
        competitionId: 'competition-one',
        contributingAccountIds: ['account-one'],
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        requesterIsPresent: false,
      }),
    ).resolves.toEqual({ kind: 'invalid_accounts' });
    await expect(
      service.join({
        competitionId: 'competition-one',
        contributingAccountIds: ['account-one', 'account-one'],
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        requesterIsPresent: true,
      }),
    ).resolves.toEqual({ kind: 'invalid_accounts' });
    expect(repository.joins).toEqual([]);
  });

  it('passes manager authorization for manual Discord and standalone-watchlist additions', async () => {
    const repository = new ParticipationRepository();
    const service = new CompetitionDraftParticipationService(
      repository,
      permissions(true),
      () => 'entrant-one',
    );

    await service.add({
      competitionId: 'competition-one',
      entrant: {
        type: 'discord_member',
        discordUserId: 'absent-member',
        contributingAccountIds: ['account-one'],
      },
      guildId: 'guild-one',
      hasAdministratorPermission: false,
      memberRoleIds: ['competition-manager'],
      requesterDiscordUserId: 'manager-one',
    });
    await service.add({
      competitionId: 'competition-one',
      entrant: { type: 'watchlist', watchlistAccountId: 'watchlist-one' },
      guildId: 'guild-one',
      hasAdministratorPermission: false,
      memberRoleIds: ['competition-manager'],
      requesterDiscordUserId: 'manager-one',
    });

    expect(repository.adds).toMatchObject([
      {
        canManageCompetitions: true,
        entrant: { type: 'discord_member', discordUserId: 'absent-member' },
      },
      {
        canManageCompetitions: true,
        entrant: { type: 'watchlist', watchlistAccountId: 'watchlist-one' },
      },
    ]);
  });

  it('does not call the repository for invalid manual participant selections', async () => {
    const repository = new ParticipationRepository();
    const service = new CompetitionDraftParticipationService(
      repository,
      permissions(true),
      () => 'entrant-one',
    );

    await expect(
      service.add({
        competitionId: 'competition-one',
        entrant: {
          type: 'discord_member',
          discordUserId: 'member-one',
          contributingAccountIds: [],
        },
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: [],
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toEqual({ kind: 'invalid_accounts' });
    expect(repository.adds).toEqual([]);
  });
});

class ParticipationRepository implements CompetitionDraftParticipationRepository {
  public readonly adds: Record<string, unknown>[] = [];
  public readonly joins: Record<string, unknown>[] = [];

  public join(request: {
    competitionId: string;
    contributingAccountIds: readonly string[];
    entrantId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    this.joins.push(request);
    return Promise.resolve({ kind: 'joined', entrant: discordEntrant(request) });
  }

  public add(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    entrant:
      | { type: 'discord_member'; discordUserId: string; contributingAccountIds: readonly string[] }
      | { type: 'watchlist'; watchlistAccountId: string };
    entrantId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    this.adds.push(request);
    return Promise.resolve({
      kind: 'added',
      entrant: discordEntrant({ ...request, contributingAccountIds: ['account-one'] }),
    });
  }

  public leave(): Promise<CompetitionParticipationResult> {
    return Promise.resolve({ kind: 'entrant_not_found' });
  }

  public remove(): Promise<CompetitionParticipationResult> {
    return Promise.resolve({ kind: 'entrant_not_found' });
  }
}

function permissions(canManageCompetitions: boolean) {
  return { evaluate: () => Promise.resolve({ canManageCompetitions }) };
}

function discordEntrant(request: {
  competitionId: string;
  contributingAccountIds: readonly string[];
  entrantId: string;
  guildId: string;
  requesterDiscordUserId: string;
}): CompetitionEntrant {
  return {
    competitionId: request.competitionId,
    contributingAccountIds: request.contributingAccountIds,
    discordUserId: request.requesterDiscordUserId,
    guildId: request.guildId,
    id: request.entrantId,
    type: 'discord_member',
  };
}
