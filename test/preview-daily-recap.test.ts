import { describe, expect, it } from 'vitest';

import type { DailyRecapPreview } from '../src/features/recaps/daily-recap-presentation.js';
import { PreviewDailyRecapService } from '../src/features/recaps/preview-daily-recap.js';

describe('preview daily recap service', () => {
  it('allows every requesting guild member and collects only that guild recap', async () => {
    const previews = new PreviewStub();
    const service = new PreviewDailyRecapService(previews);

    await expect(
      service.preview({
        guildId: 'guild-one',
        isGuildMember: true,
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toMatchObject({
      kind: 'previewed',
      preview: { collection: { guildId: 'guild-one' } },
    });
    expect(previews.guildIds).toEqual(['guild-one']);
  });

  it('refuses a non-member context before collecting a guild recap', async () => {
    const previews = new PreviewStub();
    const service = new PreviewDailyRecapService(previews);

    await expect(
      service.preview({
        guildId: 'guild-one',
        isGuildMember: false,
        requesterDiscordUserId: 'outsider-one',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    expect(previews.guildIds).toEqual([]);
  });
});

class PreviewStub {
  public readonly guildIds: string[] = [];

  public preview(guildId: string): Promise<DailyRecapPreview> {
    this.guildIds.push(guildId);
    return Promise.resolve({
      collection: {
        completedAt: new Date('2026-07-31T10:01:00.000Z'),
        guildId,
        outcomes: [],
        startedAt: new Date('2026-07-31T10:00:00.000Z'),
      },
      presentation: { failures: [], linkedMembers: [], noActivity: true, watchlistAccounts: [] },
    });
  }
}
