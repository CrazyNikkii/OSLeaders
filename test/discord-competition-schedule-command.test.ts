import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { CompetitionSchedulingService } from '../src/features/competitions/schedule-competition.js';
import {
  CompetitionScheduleCommandHandler,
  DiscordCompetitionScheduleCommandAdapter,
  type CompetitionScheduleChoices,
} from '../src/infrastructure/discord/competition-schedule-command.js';

describe('Discord competition schedule command', () => {
  it("keeps a UUID-backed modal custom ID within Discord's 100-character limit", async () => {
    const competitionId = '2f597429-b970-4cbb-96a6-6c67c2de37c9';
    const handler = new CompetitionScheduleCommandHandler(
      new CompetitionSchedulingService(new Repository(), new Permissions()),
      new Choices([{ displayName: 'UUID competition', id: competitionId }]),
    );
    const selection = await handler.start('guild-one', 'creator-one');
    if (selection.kind !== 'competition_selection')
      throw new Error('Expected competition selection.');
    const dateTime = await handler.selectCompetition({
      competitionId,
      customId: selection.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'creator-one',
    });
    if (dateTime.kind !== 'date_time_required') throw new Error('Expected local date-time input.');

    expect(dateTime.customId).toHaveLength(72);
    expect(dateTime.customId).not.toContain(competitionId);
  });

  it('bounds pending sessions and expires the oldest session when full', async () => {
    const handler = new CompetitionScheduleCommandHandler(
      new CompetitionSchedulingService(new Repository(), new Permissions()),
      new Choices(),
      undefined,
      1,
    );
    const first = await handler.start('guild-one', 'creator-one');
    if (first.kind !== 'competition_selection') throw new Error('Expected competition selection.');
    const dateTime = await handler.selectCompetition({
      competitionId: 'competition-one',
      customId: first.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'creator-one',
    });
    if (dateTime.kind !== 'date_time_required') throw new Error('Expected local date-time input.');
    await handler.start('guild-one', 'creator-one');

    await expect(
      handler.submitDateTime({
        customId: dateTime.customId,
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        localDateTime: '2026-08-10 15:30',
        memberRoleIds: [],
        requesterDiscordUserId: 'creator-one',
      }),
    ).resolves.toMatchObject({
      message: 'This interaction is no longer valid. Run the command again.',
    });
  });

  it('binds draft selection and local-time submission to the initiating member and guild', async () => {
    const repository = new Repository();
    const handler = new CompetitionScheduleCommandHandler(
      new CompetitionSchedulingService(repository, new Permissions()),
      new Choices(),
    );
    const selection = await handler.start('guild-one', 'creator-one');
    if (selection.kind !== 'competition_selection')
      throw new Error('Expected competition selection.');

    await expect(
      handler.selectCompetition({
        competitionId: 'competition-one',
        customId: selection.customId,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-two',
      }),
    ).resolves.toMatchObject({ message: 'This interaction belongs to another member or server.' });

    const newSelection = await handler.start('guild-one', 'creator-one');
    if (newSelection.kind !== 'competition_selection')
      throw new Error('Expected competition selection.');
    const dateTime = await handler.selectCompetition({
      competitionId: 'competition-one',
      customId: newSelection.customId,
      guildId: 'guild-one',
      requesterDiscordUserId: 'creator-one',
    });
    if (dateTime.kind !== 'date_time_required') throw new Error('Expected local date-time input.');
    await expect(
      handler.submitDateTime({
        customId: dateTime.customId,
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        localDateTime: '2026-08-10 15:30',
        memberRoleIds: [],
        requesterDiscordUserId: 'creator-one',
      }),
    ).resolves.toEqual({
      kind: 'scheduled',
      intendedStartAt: new Date('2026-08-10T12:30:00.000Z'),
    });
  });

  it('keeps the command private, displays a modal, and renders a Discord-native timestamp', async () => {
    const handler = new CompetitionScheduleCommandHandler(
      new CompetitionSchedulingService(new Repository(), new Permissions()),
      new Choices(),
    );
    const adapter = new DiscordCompetitionScheduleCommandAdapter(handler);
    const reply = vi.fn(() => Promise.resolve());
    await adapter.handle({
      commandName: 'competition',
      guildId: 'guild-one',
      isChatInputCommand: () => true,
      options: { getSubcommand: () => 'schedule' },
      reply,
      user: { id: 'creator-one' },
    } as never);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Choose a draft competition to schedule.',
        flags: MessageFlags.Ephemeral,
      }),
    );

    const selection = await handler.start('guild-one', 'creator-one');
    if (selection.kind !== 'competition_selection')
      throw new Error('Expected competition selection.');
    let dateTimeCustomId = '';
    const showModal = vi.fn((modal: { toJSON(): { custom_id: string } }) => {
      dateTimeCustomId = modal.toJSON().custom_id;
      return Promise.resolve();
    });
    await adapter.handle({
      customId: selection.customId,
      guildId: 'guild-one',
      isChatInputCommand: () => false,
      isStringSelectMenu: () => true,
      showModal,
      user: { id: 'creator-one' },
      values: ['competition-one'],
    } as never);
    const deferReply = vi.fn(() => Promise.resolve());
    const editReply = vi.fn(() => Promise.resolve());
    await adapter.handle({
      customId: dateTimeCustomId,
      deferReply,
      editReply,
      guildId: 'guild-one',
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      fields: { getTextInputValue: () => '2026-08-10 15:30' },
      member: null,
      memberPermissions: { has: () => false },
      user: { id: 'creator-one' },
    } as never);
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Competition scheduled for <t:1786365000:F> (<t:1786365000:R>).',
      }),
    );
  });
});

class Choices implements CompetitionScheduleChoices {
  public constructor(
    private readonly drafts = [{ displayName: 'Mining week', id: 'competition-one' }],
  ) {}
  public listDrafts() {
    return Promise.resolve(this.drafts);
  }
}
class Permissions {
  public evaluate() {
    return Promise.resolve({ canManageCompetitions: false });
  }
}
class Repository {
  public findDraft() {
    return Promise.resolve({ createdByDiscordUserId: 'creator-one', timezone: 'Europe/Helsinki' });
  }
  public setIntendedStart() {
    return Promise.resolve(true);
  }
}
