import { describe, expect, it } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import {
  CompetitionDraftParticipationService,
  type CompetitionDraftParticipationRepository,
  type CompetitionEntrant,
  type CompetitionParticipationResult,
} from '../src/features/competitions/manage-draft-participation.js';
import {
  CompetitionDraftParticipationCommandHandler,
  type CompetitionDraftParticipationAccounts,
  type CompetitionDraftParticipationChoices,
} from '../src/infrastructure/discord/competition-draft-participation-command.js';

describe('Discord competition draft participation command', () => {
  it('binds self-join account selection to the initiating member and guild', async () => {
    const repository = new Repository();
    const handler = handlerFor(repository);

    const start = await handler.start('guild-one', 'member-one', 'join');
    expect(start).toMatchObject({
      kind: 'competition_selection',
      drafts: [{ id: 'competition-one' }],
    });
    if (start.kind !== 'competition_selection') throw new Error('Expected competition selection.');

    await expect(
      handler.selectCompetition({
        competitionId: 'competition-one',
        customId: start.customId,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-two',
      }),
    ).resolves.toMatchObject({ message: 'This interaction belongs to another member or server.' });

    const accounts = await handler.selectCompetition({
      competitionId: 'competition-one',
      customId: start.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'member-one',
    });
    expect(accounts).toMatchObject({
      kind: 'account_selection',
      accounts: [{ id: 'account-one' }],
    });
    if (accounts.kind !== 'account_selection') throw new Error('Expected account selection.');

    await expect(
      handler.selectAccounts({
        accountIds: ['account-one'],
        customId: accounts.customId,
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: [],
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toMatchObject({ message: 'You joined the competition draft.' });
    expect(repository.joinRequests).toMatchObject([
      {
        competitionId: 'competition-one',
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      },
    ]);
  });

  it('allows the creator to add a standalone watchlist account and routes leave', async () => {
    const repository = new Repository();
    const handler = handlerFor(repository);
    const add = await handler.start('guild-one', 'creator-one', 'add');
    if (add.kind !== 'competition_selection') throw new Error('Expected competition selection.');
    const kind = await handler.selectCompetition({
      competitionId: 'competition-one',
      customId: add.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'creator-one',
    });
    if (kind.kind !== 'add_kind_selection') throw new Error('Expected participant type selection.');
    const accounts = await handler.selectAddKind(
      kind.customId,
      'guild-one',
      'creator-one',
      'watchlist',
    );
    if (accounts.kind !== 'account_selection') throw new Error('Expected watchlist selection.');

    await handler.selectAccounts({
      accountIds: ['watchlist-one'],
      customId: accounts.customId,
      guildId: 'guild-one',
      hasAdministratorPermission: false,
      memberRoleIds: [],
      requesterDiscordUserId: 'creator-one',
    });
    expect(repository.addRequests[0]).toMatchObject({
      entrant: { type: 'watchlist', watchlistAccountId: 'watchlist-one' },
      requesterDiscordUserId: 'creator-one',
    });

    const leave = await handler.start('guild-one', 'member-one', 'leave');
    if (leave.kind !== 'competition_selection') throw new Error('Expected competition selection.');
    await handler.selectCompetition({
      competitionId: 'competition-one',
      customId: leave.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'member-one',
    });
    expect(repository.leaveRequests).toMatchObject([
      { competitionId: 'competition-one', requesterDiscordUserId: 'member-one' },
    ]);
  });

  it('paginates every open draft instead of silently dropping drafts after Discord limits', async () => {
    const drafts = Array.from({ length: 26 }, (_, index) => ({
      id: `competition-${index + 1}`,
      displayName: `Competition ${index + 1}`,
    }));
    const handler = new CompetitionDraftParticipationCommandHandler(
      new CompetitionDraftParticipationService(
        new Repository(),
        { evaluate: () => Promise.resolve({ canManageCompetitions: false }) },
        () => 'entrant-new',
      ),
      new Choices(drafts),
      new Accounts(),
    );
    const first = await handler.start('guild-one', 'member-one', 'leave');
    if (first.kind !== 'competition_selection') throw new Error('Expected competition selection.');
    expect(first.drafts).toHaveLength(23);

    const second = await handler.selectCompetition({
      competitionId: '__next_page__',
      customId: first.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'member-one',
    });
    if (second.kind !== 'competition_selection')
      throw new Error('Expected paged competition selection.');
    expect(second.drafts[0]?.id).toBe('competition-24');
  });

  it('paginates account and entrant selections through their final partial pages', async () => {
    const accounts = Array.from({ length: 26 }, (_, index) =>
      linkedAccount(`account-${index + 1}`),
    );
    const entrants = accounts.map((account, index) =>
      entrant({
        competitionId: 'competition-one',
        contributingAccountIds: [account.id],
        entrantId: `entrant-${index + 1}`,
        guildId: 'guild-one',
        requesterDiscordUserId: `member-${index + 1}`,
      }),
    );
    const handler = new CompetitionDraftParticipationCommandHandler(
      new CompetitionDraftParticipationService(
        new Repository(),
        { evaluate: () => Promise.resolve({ canManageCompetitions: true }) },
        () => 'entrant-new',
      ),
      new Choices(undefined, entrants),
      new Accounts(accounts),
    );
    const add = await handler.start('guild-one', 'creator-one', 'add');
    if (add.kind !== 'competition_selection') throw new Error('Expected competition selection.');
    const kind = await handler.selectCompetition({
      competitionId: 'competition-one',
      customId: add.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'creator-one',
    });
    if (kind.kind !== 'add_kind_selection') throw new Error('Expected type selection.');
    const firstAccounts = await handler.selectAddKind(
      kind.customId,
      'guild-one',
      'creator-one',
      'linked',
    );
    if (firstAccounts.kind !== 'account_selection') throw new Error('Expected account selection.');
    const lastAccounts = await handler.selectAccounts({
      accountIds: ['__next_page__'],
      customId: firstAccounts.customId,
      guildId: 'guild-one',
      hasAdministratorPermission: true,
      memberRoleIds: [],
      requesterDiscordUserId: 'creator-one',
    });
    if (lastAccounts.kind !== 'account_selection')
      throw new Error('Expected paged account selection.');
    expect(lastAccounts.accounts[0]?.id).toBe('account-24');

    const remove = await handler.start('guild-one', 'creator-one', 'remove');
    if (remove.kind !== 'competition_selection') throw new Error('Expected competition selection.');
    const firstEntrants = await handler.selectCompetition({
      competitionId: 'competition-one',
      customId: remove.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'creator-one',
    });
    if (firstEntrants.kind !== 'entrant_selection') throw new Error('Expected entrant selection.');
    const lastEntrants = await handler.selectEntrant({
      customId: firstEntrants.customId,
      entrantId: '__next_page__',
      guildId: 'guild-one',
      hasAdministratorPermission: true,
      memberRoleIds: [],
      requesterDiscordUserId: 'creator-one',
    });
    if (lastEntrants.kind !== 'entrant_selection')
      throw new Error('Expected paged entrant selection.');
    expect(lastEntrants.entrants[0]?.id).toBe('entrant-24');
  });
});

function handlerFor(repository: Repository) {
  return new CompetitionDraftParticipationCommandHandler(
    new CompetitionDraftParticipationService(
      repository,
      { evaluate: () => Promise.resolve({ canManageCompetitions: false }) },
      () => 'entrant-new',
    ),
    new Choices(),
    new Accounts(),
  );
}

class Choices implements CompetitionDraftParticipationChoices {
  public constructor(
    private readonly drafts = [{ id: 'competition-one', displayName: 'Mining week' }],
    private readonly entrants: readonly CompetitionEntrant[] = [],
  ) {}
  public listDrafts() {
    return Promise.resolve(this.drafts);
  }
  public listEntrants() {
    return Promise.resolve(this.entrants);
  }
}

class Accounts implements CompetitionDraftParticipationAccounts {
  public constructor(private readonly accounts = [linkedAccount(), watchlistAccount()]) {}
  public listForGuild(): Promise<TrackedAccount[]> {
    return Promise.resolve(this.accounts);
  }
  public listLinkedForMember(): Promise<TrackedAccount[]> {
    return Promise.resolve([linkedAccount()]);
  }
}

class Repository implements CompetitionDraftParticipationRepository {
  public readonly addRequests: Record<string, unknown>[] = [];
  public readonly joinRequests: Record<string, unknown>[] = [];
  public readonly leaveRequests: Record<string, unknown>[] = [];
  public join(request: {
    competitionId: string;
    contributingAccountIds: readonly string[];
    entrantId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    this.joinRequests.push(request);
    return Promise.resolve({ kind: 'joined', entrant: entrant(request) });
  }
  public add(
    request: Record<string, unknown> & {
      competitionId: string;
      entrantId: string;
      guildId: string;
    },
  ): Promise<CompetitionParticipationResult> {
    this.addRequests.push(request);
    return Promise.resolve({
      kind: 'added',
      entrant: entrant({
        ...request,
        requesterDiscordUserId: 'member-one',
        contributingAccountIds: ['watchlist-one'],
      }),
    });
  }
  public leave(request: Record<string, unknown>): Promise<CompetitionParticipationResult> {
    this.leaveRequests.push(request);
    return Promise.resolve({
      kind: 'left',
      entrant: entrant({
        competitionId: 'competition-one',
        entrantId: 'entrant-one',
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        contributingAccountIds: ['account-one'],
      }),
    });
  }
  public remove(): Promise<CompetitionParticipationResult> {
    return Promise.resolve({ kind: 'entrant_not_found' });
  }
}

function entrant(request: {
  competitionId: string;
  contributingAccountIds: readonly string[];
  entrantId: string;
  guildId: string;
  requesterDiscordUserId: string;
}): CompetitionEntrant {
  return {
    id: request.entrantId,
    competitionId: request.competitionId,
    guildId: request.guildId,
    type: 'discord_member',
    discordUserId: request.requesterDiscordUserId,
    contributingAccountIds: request.contributingAccountIds,
  };
}
function linkedAccount(id = 'account-one'): TrackedAccount {
  return {
    id,
    guildId: 'guild-one',
    displayUsername: 'Member account',
    normalizedUsername: 'member account',
    accountMode: 'main',
    association: { type: 'linked', discordUserId: 'member-one' },
    isDefault: true,
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
    createdAt: new Date(),
  };
}
function watchlistAccount(): TrackedAccount {
  return {
    ...linkedAccount(),
    id: 'watchlist-one',
    displayUsername: 'Watchlist account',
    association: { type: 'watchlist' },
  };
}
