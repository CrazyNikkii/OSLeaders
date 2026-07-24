import { describe, expect, it } from 'vitest';

import completeResponse from './fixtures/hiscores/complete-osrs-response.json' with { type: 'json' };
import {
  AccountModeValidator,
  type AccountModeHiscoreFetcher,
} from '../src/features/accounts/validate-account-mode.js';
import { parseHiscoreResponse } from '../src/infrastructure/hiscores/parse-hiscore-response.js';
import type {
  HiscoreParseResult,
  HiscoreResult,
} from '../src/infrastructure/hiscores/hiscore-result.js';
import {
  OSRS_MODE_FETCH_STRATEGIES,
  type OsrsHiscoreEndpoint,
} from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

type FetchResult = HiscoreParseResult | Exclude<HiscoreResult, { kind: 'success' }>;

const parsedFixture = (() => {
  const result = parseHiscoreResponse(completeResponse);
  if (result.kind !== 'success') {
    throw new Error('Hiscores fixture must parse successfully.');
  }

  return result;
})();

describe('account mode validation', () => {
  it.each([
    ['main', 'hiscore_oldschool', 'server_managed'],
    ['hardcore_ironman', 'hiscore_oldschool_hardcore_ironman', 'endpoint_verified'],
    ['ultimate_ironman', 'hiscore_oldschool_ultimate', 'endpoint_verified'],
    ['group_ironman', 'hiscore_oldschool', 'server_managed'],
    ['hardcore_group_ironman', 'hiscore_oldschool', 'server_managed'],
  ] as const)(
    'uses the approved %s strategy and verification statement',
    async (accountMode, endpoint, modeVerification) => {
      const fetcher = new StubHiscoreFetcher([success()]);
      const validator = createValidator(fetcher);

      await expect(
        validator.validate({ accountMode, username: 'Fixture Player' }),
      ).resolves.toMatchObject({
        kind: 'success',
        accountMode,
        endpoint,
        modeVerification,
      });
      expect(fetcher.calls).toEqual([{ endpoint, username: 'Fixture Player' }]);
    },
  );

  it('accepts regular Ironman only after both more-specific endpoints are absent', async () => {
    const fetcher = new StubHiscoreFetcher([success(), notFound(), notFound()]);
    const validator = createValidator(fetcher);

    await expect(
      validator.validate({ accountMode: 'ironman', username: 'Fixture Player' }),
    ).resolves.toMatchObject({
      kind: 'success',
      accountMode: 'ironman',
      endpoint: 'hiscore_oldschool_ironman',
      modeVerification: 'endpoint_verified',
    });
    expect(fetcher.calls.map(({ endpoint }) => endpoint)).toEqual([
      'hiscore_oldschool_ironman',
      'hiscore_oldschool_hardcore_ironman',
      'hiscore_oldschool_ultimate',
    ]);
  });

  it('rejects Ironman when the Hardcore endpoint succeeds', async () => {
    const fetcher = new StubHiscoreFetcher([success(), success()]);
    const validator = createValidator(fetcher);

    await expect(
      validator.validate({ accountMode: 'ironman', username: 'Fixture Player' }),
    ).resolves.toEqual({
      kind: 'mode_incompatible',
    });
    expect(fetcher.calls.map(({ endpoint }) => endpoint)).toEqual([
      'hiscore_oldschool_ironman',
      'hiscore_oldschool_hardcore_ironman',
    ]);
  });

  it('rejects Ironman when the Ultimate endpoint succeeds', async () => {
    const fetcher = new StubHiscoreFetcher([success(), notFound(), success()]);
    const validator = createValidator(fetcher);

    await expect(
      validator.validate({ accountMode: 'ironman', username: 'Fixture Player' }),
    ).resolves.toEqual({
      kind: 'mode_incompatible',
    });
  });

  it.each<FetchResult>([
    { kind: 'not_found' },
    { kind: 'timeout' },
    { kind: 'temporary_upstream_failure' },
    { kind: 'malformed_response', reason: 'Invalid JSON.' },
    { kind: 'incomplete_response', missing: ['skill:Sailing'] },
  ])('returns the primary %s result unchanged', async (failure) => {
    const fetcher = new StubHiscoreFetcher([failure]);
    const validator = createValidator(fetcher);

    await expect(
      validator.validate({ accountMode: 'main', username: 'Fixture Player' }),
    ).resolves.toEqual(failure);
    expect(fetcher.calls).toHaveLength(1);
  });

  it('does not accept regular Ironman when a specific endpoint is unavailable', async () => {
    const fetcher = new StubHiscoreFetcher([success(), { kind: 'temporary_upstream_failure' }]);
    const validator = createValidator(fetcher);

    await expect(
      validator.validate({ accountMode: 'ironman', username: 'Fixture Player' }),
    ).resolves.toEqual({
      kind: 'temporary_upstream_failure',
    });
    expect(fetcher.calls).toHaveLength(2);
  });

  it('returns an Ultimate endpoint failure after Hardcore is absent', async () => {
    const incompleteResult = {
      kind: 'incomplete_response',
      missing: ['activity:Abyssal Sire'],
    } as const;
    const fetcher = new StubHiscoreFetcher([success(), notFound(), incompleteResult]);
    const validator = createValidator(fetcher);

    await expect(
      validator.validate({ accountMode: 'ironman', username: 'Fixture Player' }),
    ).resolves.toEqual(incompleteResult);
  });
});

function createValidator(fetcher: AccountModeHiscoreFetcher): AccountModeValidator {
  return new AccountModeValidator(fetcher, OSRS_MODE_FETCH_STRATEGIES);
}

function success(): Extract<HiscoreParseResult, { kind: 'success' }> {
  return parsedFixture;
}

function notFound(): Extract<HiscoreResult, { kind: 'not_found' }> {
  return { kind: 'not_found' };
}

class StubHiscoreFetcher implements AccountModeHiscoreFetcher {
  public readonly calls: { endpoint: OsrsHiscoreEndpoint; username: string }[] = [];
  private nextResultIndex = 0;

  public constructor(private readonly results: readonly FetchResult[]) {}

  public fetchHiscores(endpoint: OsrsHiscoreEndpoint, username: string): Promise<FetchResult> {
    this.calls.push({ endpoint, username });
    const result = this.results[this.nextResultIndex++];
    if (result === undefined) {
      throw new Error('Test fetcher received more calls than configured results.');
    }

    return Promise.resolve(result);
  }
}
