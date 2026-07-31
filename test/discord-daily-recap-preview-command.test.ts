import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import type { DailyRecapPreview } from '../src/features/recaps/daily-recap-presentation.js';
import type {
  PreviewDailyRecapRequest,
  PreviewDailyRecapResult,
} from '../src/features/recaps/preview-daily-recap.js';
import {
  DiscordDailyRecapPreviewCommandAdapter,
  dailyRecapPreviewCommandDefinitions,
  dailyRecapPreviewEmbeds,
} from '../src/infrastructure/discord/daily-recap-preview-command.js';

describe('Discord daily recap preview command', () => {
  it('registers guild-only preview, send, and configuration recap subcommands', () => {
    const definition = dailyRecapPreviewCommandDefinitions[0];

    expect(definition).toMatchObject({
      description: 'Configure, view, or send a daily recap.',
      name: 'recap',
    });
    expect(JSON.stringify(definition)).toContain('"name":"preview"');
    const serialized = JSON.stringify(definition);
    expect(serialized).toContain('without updating baselines');
    expect(serialized).toContain('"name":"send"');
    expect(serialized).toContain('"name":"configure"');
    expect(serialized).toContain('"name":"timezone"');
  });

  it('uses the interaction guild, keeps the result private, and does not invoke delivery', async () => {
    const previews = new PreviewServiceStub(preview());
    const adapter = new DiscordDailyRecapPreviewCommandAdapter(previews);
    const responses = responseInteractions();

    await adapter.handle(interaction(responses) as never);

    expect(previews.requests).toEqual([
      {
        guildId: 'guild-one',
        isGuildMember: true,
        requesterDiscordUserId: 'member-one',
      },
    ]);
    expect(responses.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const response = JSON.stringify(responses.editReply.mock.calls[0]);
    expect(response).toContain('<@member-one>');
    expect(response).toContain('## Linked (Ironman)');
    expect(response).toContain('**Skills**');
    expect(response).toContain('+100,000 XP');
    expect(response).toContain('**Boss activities**');
    expect(response).toContain('## Watchlisted (Ironman)');
    expect(response).toContain('Unavailable accounts');
    expect(response.indexOf('**Boss activities**')).toBeLessThan(response.indexOf('**Skills**'));
    expect(responses.followUp).not.toHaveBeenCalled();
  });

  it('shows no activity privately while preserving separately reported failures', async () => {
    const previews = new PreviewServiceStub(
      preview({
        failures: [
          { account: account({ displayUsername: 'Missing' }), failure: { kind: 'timeout' } },
        ],
        linkedMembers: [],
        noActivity: true,
        watchlistAccounts: [],
      }),
    );
    const adapter = new DiscordDailyRecapPreviewCommandAdapter(previews);
    const responses = responseInteractions();

    await adapter.handle(interaction(responses) as never);

    const response = JSON.stringify(responses.editReply.mock.calls[0]);
    expect(response).toContain('No tracked XP or boss KC gains since the previous recap.');
    expect(response).toContain('Missing');
    expect(response).toContain('Hiscores timed out');
  });

  it('does not run in direct messages', async () => {
    const previews = new PreviewServiceStub(preview());
    const adapter = new DiscordDailyRecapPreviewCommandAdapter(previews);
    const responses = responseInteractions();

    await adapter.handle(interaction(responses, null) as never);

    expect(previews.requests).toEqual([]);
    expect(responses.deferReply).not.toHaveBeenCalled();
    expect(responses.reply).toHaveBeenCalledWith({
      content: 'This command can only be used in a Discord server.',
    });
  });

  it('splits long valid previews into bounded, numbered embed pages', () => {
    const accounts = Array.from({ length: 140 }, (_, index) => ({
      account: account({ displayUsername: `A long tracked account ${index + 1}` }),
      changes: {
        bosses: [{ boss: 'Abyssal Sire', killCountGained: index + 1 }],
        skills: [
          {
            currentLevel: 99,
            experienceGained: 100_000 + index,
            levelGained: 1,
            skill: 'Strength',
          },
        ],
      },
      previousBaselineCapturedAt: new Date('2026-07-30T10:00:00.000Z'),
    }));

    const embeds = dailyRecapPreviewEmbeds(
      preview({
        failures: [],
        linkedMembers: [{ accounts, discordUserId: 'member-one' }],
        noActivity: false,
        watchlistAccounts: [],
      }),
    );

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds.every((embed) => (embed.data.description?.length ?? 0) <= 4_096)).toBe(true);
    expect(embeds[0]?.data.title).toContain('(1/');
    expect(JSON.stringify(embeds)).toContain('A long tracked account 140');
  });
});

class PreviewServiceStub {
  public readonly requests: PreviewDailyRecapRequest[] = [];

  public constructor(private readonly result: DailyRecapPreview) {}

  public preview(request: PreviewDailyRecapRequest): Promise<PreviewDailyRecapResult> {
    this.requests.push(request);
    return Promise.resolve({
      kind: 'previewed',
      preview: {
        ...this.result,
        collection: { ...this.result.collection, guildId: request.guildId },
      },
    });
  }
}

function interaction(
  responses: ReturnType<typeof responseInteractions>,
  guildId: string | null = 'guild-one',
) {
  return {
    commandName: 'recap',
    guildId,
    isChatInputCommand: () => true,
    options: { getSubcommand: () => 'preview' },
    user: { id: 'member-one' },
    ...responses,
  };
}

function responseInteractions() {
  return {
    deferReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
  };
}

function preview(
  presentation: DailyRecapPreview['presentation'] = {
    failures: [
      { account: account({ displayUsername: 'Unavailable' }), failure: { kind: 'not_found' } },
    ],
    linkedMembers: [
      {
        accounts: [
          {
            account: account({ displayUsername: 'Linked' }),
            changes: {
              bosses: [{ boss: 'Zulrah', killCountGained: 4 }],
              skills: [
                {
                  currentLevel: 88,
                  experienceGained: 100_000,
                  levelGained: 1,
                  skill: 'Magic',
                },
              ],
            },
            previousBaselineCapturedAt: new Date('2026-07-30T10:00:00.000Z'),
          },
        ],
        discordUserId: 'member-one',
      },
    ],
    noActivity: false,
    watchlistAccounts: [
      {
        account: account({
          association: { type: 'watchlist' },
          displayUsername: 'Watchlisted',
          id: 'watchlist-one',
        }),
        changes: {
          bosses: [],
          skills: [
            {
              currentLevel: 90,
              experienceGained: 500_000,
              levelGained: 3,
              skill: 'Crafting',
            },
          ],
        },
        previousBaselineCapturedAt: new Date('2026-07-30T10:00:00.000Z'),
      },
    ],
  },
): DailyRecapPreview {
  return {
    collection: {
      completedAt: new Date('2026-07-31T10:01:00.000Z'),
      guildId: 'guild-one',
      outcomes: [],
      startedAt: new Date('2026-07-31T10:00:00.000Z'),
    },
    presentation,
  };
}

function account(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    accountMode: 'ironman',
    association: { discordUserId: 'member-one', type: 'linked' },
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    displayUsername: 'Rune Scape',
    guildId: 'guild-one',
    id: 'account-one',
    isDefault: true,
    normalizedUsername: 'rune scape',
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
    ...overrides,
  };
}
