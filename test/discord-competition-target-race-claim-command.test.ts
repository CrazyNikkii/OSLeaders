import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { TargetRaceClaimResult } from '../src/features/competitions/claim-target-race.js';
import {
  CompetitionTargetRaceClaimCommandHandler,
  DiscordCompetitionTargetRaceClaimCommandAdapter,
  type TargetRaceClaimChoices,
} from '../src/infrastructure/discord/competition-target-race-claim-command.js';

describe('Discord target-race claim command', () => {
  it('binds the target-race entrant selection to the initiating member and guild', async () => {
    const claims = new Claims();
    const handler = new CompetitionTargetRaceClaimCommandHandler(
      claims,
      new Choices(),
      new Permissions(),
    );
    const selection = await handler.start(request());
    if (selection.kind !== 'selection') throw new Error('Expected selection.');

    await expect(
      handler.selectEntrant({
        ...request({ requesterDiscordUserId: 'member-two' }),
        customId: selection.customId,
        entrantId: 'entrant-one',
      }),
    ).resolves.toMatchObject({ message: 'This interaction belongs to another member or server.' });

    await expect(
      handler.selectEntrant({
        ...request(),
        customId: selection.customId,
        entrantId: 'entrant-one',
      }),
    ).resolves.toMatchObject({
      kind: 'won',
      message: 'Target-race claim verified: +50 progress.',
    });
    expect(claims.claims).toEqual([
      expect.objectContaining({
        competitionId: 'competition-one',
        entrantId: 'entrant-one',
        requesterIsPresent: true,
      }),
    ]);
  });

  it('acknowledges before verification and binds retry verification to the original member', async () => {
    const order: string[] = [];
    const claims = new Claims(
      {
        claim: {
          claimId: 'claim-one',
          failures: [{ kind: 'timeout' }],
          kind: 'verification_pending',
        },
        retry: { claimId: 'claim-one', finalValue: 75n, kind: 'won', verifiedAt: new Date() },
      },
      () => order.push('verify'),
    );
    const handler = new CompetitionTargetRaceClaimCommandHandler(
      claims,
      new Choices(),
      new Permissions(),
    );
    const selection = await handler.start(request());
    if (selection.kind !== 'selection') throw new Error('Expected selection.');
    const adapter = new DiscordCompetitionTargetRaceClaimCommandAdapter(handler);
    const deferUpdate = vi.fn(() => {
      order.push('defer');
      return Promise.resolve();
    });
    const editReply = vi.fn<(...args: [unknown]) => Promise<void>>(() => Promise.resolve());

    await adapter.handle({
      ...componentInteraction(selection.customId, deferUpdate, editReply),
      isButton: () => false,
      isStringSelectMenu: () => true,
      values: ['entrant-one'],
    } as never);

    expect(order).toEqual(['defer', 'verify']);
    const retryResponse = editReply.mock.calls[0]?.[0] as {
      components: [{ components: [{ data: { custom_id: string } }] }];
    };
    const retryCustomId = retryResponse.components[0].components[0].data.custom_id;
    const send = vi.fn(() => Promise.resolve());
    await adapter.handle({
      ...componentInteraction(
        retryCustomId,
        vi.fn(() => Promise.resolve()),
        editReply,
      ),
      channel: { isSendable: () => true, send },
      deleteReply: vi.fn(() => Promise.resolve()),
      isButton: () => true,
      isStringSelectMenu: () => false,
      values: [],
    } as never);
    expect(claims.retries).toEqual([expect.objectContaining({ claimId: 'claim-one' })]);
    expect(send).toHaveBeenCalledOnce();
  });

  it('publishes a verified winner publicly and removes the private interaction', async () => {
    const handler = new CompetitionTargetRaceClaimCommandHandler(
      new Claims(),
      new Choices(),
      new Permissions(),
    );
    const selection = await handler.start(request());
    if (selection.kind !== 'selection') throw new Error('Expected selection.');
    const adapter = new DiscordCompetitionTargetRaceClaimCommandAdapter(handler);
    const send = vi.fn(() => Promise.resolve());
    const deleteReply = vi.fn(() => Promise.resolve());

    await adapter.handle({
      ...componentInteraction(
        selection.customId,
        vi.fn(() => Promise.resolve()),
        vi.fn(),
      ),
      channel: { isSendable: () => true, send },
      deleteReply,
      isButton: () => false,
      isStringSelectMenu: () => true,
      values: ['entrant-one'],
    } as never);

    expect(send).toHaveBeenCalledWith({ content: 'Target-race claim verified: +50 progress.' });
    expect(deleteReply).toHaveBeenCalledOnce();
  });

  it('reports private-reply cleanup failure without misreporting a published winner', async () => {
    const handler = new CompetitionTargetRaceClaimCommandHandler(
      new Claims(),
      new Choices(),
      new Permissions(),
    );
    const selection = await handler.start(request());
    if (selection.kind !== 'selection') throw new Error('Expected selection.');
    const adapter = new DiscordCompetitionTargetRaceClaimCommandAdapter(handler);
    const send = vi.fn(() => Promise.resolve());
    const cleanupFailure = new Error('private reply unavailable');
    const editReply = vi.fn(() => Promise.resolve());

    await expect(
      adapter.handle({
        ...componentInteraction(
          selection.customId,
          vi.fn(() => Promise.resolve()),
          editReply,
        ),
        channel: { isSendable: () => true, send },
        deleteReply: vi.fn(() => Promise.reject(cleanupFailure)),
        isButton: () => false,
        isStringSelectMenu: () => true,
        values: ['entrant-one'],
      } as never),
    ).rejects.toBe(cleanupFailure);

    expect(send).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledWith({
      components: [],
      content:
        'Your claim was verified and announced publicly, but I could not remove this private confirmation.',
    });
  });

  it('keeps the command and expected failures private', async () => {
    const adapter = new DiscordCompetitionTargetRaceClaimCommandAdapter(
      new CompetitionTargetRaceClaimCommandHandler(
        new Claims(),
        new Choices([]),
        new Permissions(),
      ),
    );
    const reply = vi.fn(() => Promise.resolve());

    await adapter.handle({
      commandName: 'competition',
      guildId: 'guild-one',
      isChatInputCommand: () => true,
      options: { getSubcommand: () => 'claim' },
      reply,
      user: { id: 'member-one' },
    } as never);

    expect(reply).toHaveBeenCalledWith({
      components: [],
      content: 'You have no active target-race entries that can be claimed.',
      flags: MessageFlags.Ephemeral,
    });
  });
});

class Choices implements TargetRaceClaimChoices {
  public constructor(
    private readonly entrants: readonly {
      competitionId: string;
      displayName: string;
      entrantId: string;
    }[] = [
      {
        competitionId: 'competition-one',
        displayName: 'Mining target race',
        entrantId: 'entrant-one',
      },
    ],
  ) {}
  public listClaimableEntrants() {
    return Promise.resolve(this.entrants);
  }
}

class Permissions {
  public evaluate() {
    return Promise.resolve({ canManageCompetitions: false });
  }
}

class Claims {
  public readonly claims: object[] = [];
  public readonly retries: object[] = [];
  public constructor(
    private readonly results: {
      claim: TargetRaceClaimResult;
      retry: TargetRaceClaimResult;
    } = {
      claim: { claimId: 'claim-one', finalValue: 50n, kind: 'won', verifiedAt: new Date() },
      retry: { claimId: 'claim-one', finalValue: 50n, kind: 'won', verifiedAt: new Date() },
    },
    private readonly verified: () => void = () => undefined,
  ) {}
  public claim(request: object) {
    this.claims.push(request);
    this.verified();
    return Promise.resolve(this.results.claim);
  }
  public retry(request: object) {
    this.retries.push(request);
    this.verified();
    return Promise.resolve(this.results.retry);
  }
}

function request(overrides: Partial<{ requesterDiscordUserId: string }> = {}) {
  return {
    guildId: 'guild-one',
    hasAdministratorPermission: false,
    memberRoleIds: [],
    requesterDiscordUserId: 'member-one',
    ...overrides,
  };
}

function componentInteraction(
  customId: string,
  deferUpdate: () => Promise<void>,
  editReply: ReturnType<typeof vi.fn>,
) {
  return {
    customId,
    deferUpdate,
    editReply,
    guildId: 'guild-one',
    isChatInputCommand: () => false,
    member: { roles: [] },
    memberPermissions: { has: () => false },
    user: { id: 'member-one' },
  };
}
