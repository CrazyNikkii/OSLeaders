import { describe, expect, it } from 'vitest';

import {
  TargetRaceClaimService,
  type TargetRaceClaimHiscoreFetcher,
  type TargetRaceClaimRepository,
} from '../src/features/competitions/claim-target-race.js';
import type { OsrsHiscoreEndpoint } from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('target-race claim service', () => {
  it('records a receipt before cache-bypassing every account fetch and finalizes combined gain', async () => {
    const repository = new Repository();
    const hiscores = new Hiscores({ Alpha: success(140), Bravo: success(70) });
    const service = serviceFor(repository, hiscores);

    await expect(service.claim(request())).resolves.toMatchObject({
      kind: 'won',
      claimId: 'claim-one',
      finalValue: 60n,
    });
    expect(repository.begun[0]).toMatchObject({
      claimId: 'claim-one',
      receivedAt: new Date('2026-08-10T14:00:00.000Z'),
    });
    expect(hiscores.options).toEqual([{ cacheMode: 'bypass' }, { cacheMode: 'bypass' }]);
    expect(repository.finalized[0]).toMatchObject({ claimId: 'claim-one', finalValue: 60n });
  });

  it('leaves a temporary Hiscores failure pending and safely retries the same receipt', async () => {
    const repository = new Repository();
    const hiscores = new Hiscores({ Alpha: { kind: 'timeout' }, Bravo: success(70) });
    const service = serviceFor(repository, hiscores);

    await expect(service.claim(request())).resolves.toEqual({
      kind: 'verification_pending',
      claimId: 'claim-one',
      failures: [{ kind: 'timeout' }],
    });
    expect(repository.failures).toEqual([
      { claimId: 'claim-one', failureSummary: 'timeout', guildId: 'guild-one' },
    ]);

    hiscores.responses.Alpha = success(140);
    await expect(service.retry(retryRequest())).resolves.toMatchObject({
      kind: 'won',
      finalValue: 60n,
    });
    expect(repository.retried).toEqual(['claim-one']);
    expect(repository.finalized).toHaveLength(1);
  });

  it('does not create a claim or fetch when the requester is absent', async () => {
    const repository = new Repository();
    const hiscores = new Hiscores({ Alpha: success(140), Bravo: success(70) });
    const service = serviceFor(repository, hiscores);

    await expect(service.claim(request({ requesterIsPresent: false }))).resolves.toEqual({
      kind: 'forbidden',
    });
    expect(repository.begun).toEqual([]);
    expect(hiscores.options).toEqual([]);
  });

  it('marks permanent Hiscores failures non-retryable so they cannot block later claims', async () => {
    const repository = new Repository();
    const service = serviceFor(
      repository,
      new Hiscores({ Alpha: { kind: 'not_found' }, Bravo: success(70) }),
    );

    await expect(service.claim(request())).resolves.toEqual({
      kind: 'verification_failed',
      claimId: 'claim-one',
      failures: [{ kind: 'not_found' }],
    });
    expect(repository.verificationFailures).toEqual([
      { claimId: 'claim-one', failureSummary: 'not_found', guildId: 'guild-one' },
    ]);
    expect(repository.failures).toEqual([]);
  });

  it('automatically retries the oldest pending claim with its original receipt', async () => {
    const repository = new Repository();
    repository.dueClaim = ready('claim-earlier', new Date('2026-08-10T13:59:00.000Z'));
    const service = serviceFor(
      repository,
      new Hiscores({ Alpha: success(140), Bravo: success(70) }),
    );

    await expect(service.retryDue()).resolves.toMatchObject({
      kind: 'won',
      claimId: 'claim-earlier',
    });
    expect(repository.finalized[0]?.claimId).toBe('claim-earlier');
  });
});

class Repository implements TargetRaceClaimRepository {
  public readonly begun: { claimId: string; receivedAt: Date }[] = [];
  public readonly failures: { claimId: string; failureSummary: string; guildId: string }[] = [];
  public readonly finalized: { claimId: string; finalValue: bigint }[] = [];

  public dueClaim: ReturnType<typeof ready> | undefined;
  public claimDueRetry() {
    return Promise.resolve(this.dueClaim);
  }
  public readonly retried: string[] = [];
  public readonly verificationFailures: {
    claimId: string;
    failureSummary: string;
    guildId: string;
  }[] = [];

  public beginClaim(request: { claimId: string; receivedAt: Date }) {
    this.begun.push(request);
    return Promise.resolve({
      kind: 'ready' as const,
      claim: ready(request.claimId, request.receivedAt),
    });
  }
  public prepareRetry(request: { claimId: string }) {
    this.retried.push(request.claimId);
    return Promise.resolve({
      kind: 'ready' as const,
      claim: ready(request.claimId, new Date('2026-08-10T14:00:00.000Z')),
    });
  }
  public recordTemporaryFailure(request: {
    claimId: string;
    failureSummary: string;
    guildId: string;
  }) {
    this.failures.push(request);
    return Promise.resolve();
  }
  public recordVerificationFailure(request: {
    claimId: string;
    failureSummary: string;
    guildId: string;
  }) {
    this.verificationFailures.push(request);
    return Promise.resolve();
  }
  public finalize(request: { claimId: string; finalValue: bigint; verifiedAt: Date }) {
    this.finalized.push(request);
    return Promise.resolve({ kind: 'won' as const, ...request });
  }
}

class Hiscores implements TargetRaceClaimHiscoreFetcher {
  public readonly options: { cacheMode: 'bypass' }[] = [];
  public constructor(
    public readonly responses: Record<
      string,
      ReturnType<typeof success> | { kind: 'not_found' | 'timeout' }
    >,
  ) {}
  public fetchHiscores(
    _endpoint: OsrsHiscoreEndpoint,
    username: string,
    options: { cacheMode: 'bypass' },
  ) {
    this.options.push(options);
    return Promise.resolve(this.responses[username]!);
  }
}

function serviceFor(repository: Repository, hiscores: Hiscores) {
  return new TargetRaceClaimService(
    repository,
    { evaluate: () => Promise.resolve({ canManageCompetitions: false }) },
    hiscores,
    () => 'claim-one',
    () => new Date('2026-08-10T14:00:00.000Z'),
  );
}

function ready(claimId: string, receivedAt: Date) {
  return {
    accounts: [
      {
        accountMode: 'main' as const,
        displayUsername: 'Alpha',
        id: 'account-alpha',
        startingValue: 100n,
      },
      {
        accountMode: 'main' as const,
        displayUsername: 'Bravo',
        id: 'account-bravo',
        startingValue: 50n,
      },
    ],
    claimId,
    competitionId: 'competition-one',
    entrantId: 'entrant-one',
    guildId: 'guild-one',
    metric: { kind: 'skill' as const, name: 'Woodcutting' },
    receivedAt,
    targetValue: 50n,
  };
}

function success(experience: number) {
  return {
    kind: 'success' as const,
    data: {
      activities: [],
      bosses: [],
      returnedName: 'Player',
      skills: [{ id: 8, level: 1, name: 'Woodcutting' as const, experience, rank: 1 }],
    },
  };
}

function request(overrides: Partial<{ requesterIsPresent: boolean }> = {}) {
  return {
    competitionId: 'competition-one',
    entrantId: 'entrant-one',
    guildId: 'guild-one',
    hasAdministratorPermission: false,
    memberRoleIds: [],
    requesterDiscordUserId: 'member-one',
    requesterIsPresent: true,
    ...overrides,
  };
}

function retryRequest() {
  return {
    claimId: 'claim-one',
    guildId: 'guild-one',
    hasAdministratorPermission: false,
    memberRoleIds: [],
    requesterDiscordUserId: 'member-one',
    requesterIsPresent: true,
  };
}
