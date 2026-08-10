import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type {
  CompetitionDraft,
  CreateCompetitionRequest,
  CreateCompetitionResult,
} from '../src/features/competitions/create-competition.js';
import type { GuildConfiguration } from '../src/features/guild-configuration/guild-configuration-service.js';
import {
  CompetitionCreateCommandHandler,
  DiscordCompetitionCreateCommandAdapter,
  InMemoryCompetitionCreateSessionStore,
  competitionCommandDefinitions,
} from '../src/infrastructure/discord/competition-create-command.js';

describe('Discord competition create command', () => {
  it('registers guild-only competition creation and participation subcommands', () => {
    const command = competitionCommandDefinitions[0];
    if (command === undefined) throw new Error('Expected competition command definition.');
    expect(command).toMatchObject({
      description: 'Create and manage competitions.',
      name: 'competition',
    });
    expect((command.options ?? []).map((option) => option.name)).toEqual([
      'create',
      'join',
      'leave',
      'add',
      'remove',
      'start',
      'schedule',
      'standings',
      'claim',
    ]);
  });

  it('collects a timed skill competition draft and uses the configured guild timezone', async () => {
    const competitions = new CompetitionStub();
    const handler = new CompetitionCreateCommandHandler(competitions, new ConfigurationStub());

    const start = handler.start('guild-one', 'manager-one');
    if (start.kind !== 'name_required') throw new Error('Expected competition name input.');
    const name = handler.submitName(
      'guild-one',
      'manager-one',
      start.customId,
      ' Weekend Woodcutting ',
    );
    if (name.kind !== 'type_selection') throw new Error('Expected type selection.');
    const type = handler.selectType('guild-one', 'manager-one', name.customId, 'most_skill_xp');
    if (type.kind !== 'metric_selection') throw new Error('Expected metric selection.');
    const metric = handler.selectMetric(
      'guild-one',
      'manager-one',
      type.customIdForGroup(0),
      'Woodcutting',
    );
    if (metric.kind !== 'value_required') throw new Error('Expected duration input.');

    await expect(
      handler.submitValue({
        customId: metric.customId,
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: ['competition-manager'],
        requesterDiscordUserId: 'manager-one',
        value: '604800',
      }),
    ).resolves.toEqual({ kind: 'created', competitionName: 'Weekend Woodcutting' });

    expect(competitions.requests).toEqual([
      {
        createdByDiscordUserId: 'manager-one',
        durationSeconds: 604800,
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: ['competition-manager'],
        metric: { kind: 'skill', name: 'Woodcutting' },
        name: ' Weekend Woodcutting ',
        timezone: 'Europe/Helsinki',
        type: 'most_skill_xp',
      },
    ]);
  });

  it('uses canonical boss selections, bigint targets, and an optional deadline for target races', async () => {
    const competitions = new CompetitionStub();
    const handler = new CompetitionCreateCommandHandler(competitions, new ConfigurationStub());
    const start = handler.start('guild-one', 'manager-one');
    if (start.kind !== 'name_required') throw new Error('Expected competition name input.');
    const name = handler.submitName('guild-one', 'manager-one', start.customId, 'Mad Angel goal');
    if (name.kind !== 'type_selection') throw new Error('Expected type selection.');
    const type = handler.selectType(
      'guild-one',
      'manager-one',
      name.customId,
      'boss_kc_target_race',
    );
    if (type.kind !== 'metric_selection') throw new Error('Expected metric selection.');
    const metric = handler.selectMetric(
      'guild-one',
      'manager-one',
      type.customIdForGroup(0),
      'Mad Angel',
    );
    if (metric.kind !== 'value_required') throw new Error('Expected target input.');

    await handler.submitValue({
      customId: metric.customId,
      guildId: 'guild-one',
      hasAdministratorPermission: true,
      memberRoleIds: [],
      requesterDiscordUserId: 'manager-one',
      deadline: '604800',
      value: '1000000000000',
    });

    expect(competitions.requests[0]).toMatchObject({
      durationSeconds: 604800,
      metric: { kind: 'boss', name: 'Mad Angel' },
      targetValue: 1_000_000_000_000n,
      type: 'boss_kc_target_race',
    });
  });

  it('renders the shared Raids selector and accepts a raid metric', async () => {
    const adapter = new DiscordCompetitionCreateCommandAdapter(
      new CompetitionCreateCommandHandler(new CompetitionStub(), new ConfigurationStub()),
    );
    let nameCustomId = '';
    await adapter.handle(
      commandInteraction(
        vi.fn((modal: { toJSON(): { custom_id: string } }) => {
          nameCustomId = modal.toJSON().custom_id;
          return Promise.resolve();
        }),
      ) as never,
    );

    let typeCustomId = '';
    await adapter.handle(
      nameModalInteraction(
        nameCustomId,
        vi.fn((response: { components: { components: { data: { custom_id: string } }[] }[] }) => {
          typeCustomId = response.components[0]?.components[0]?.data.custom_id ?? '';
          return Promise.resolve();
        }),
      ) as never,
    );

    let raidCustomId = '';
    const update = vi.fn(
      (response: {
        components: { components: { data: { custom_id: string; placeholder?: string } }[] }[];
      }) => {
        expect(response.components.map((row) => row.components[0]?.data.placeholder)).toEqual([
          'Choose raid',
          'Choose boss (A–G)',
          'Choose boss (G–S)',
          'Choose boss (S–Z)',
        ]);
        raidCustomId = response.components[0]?.components[0]?.data.custom_id ?? '';
        return Promise.resolve();
      },
    );
    await adapter.handle(selectInteraction(typeCustomId, 'boss_kc_target_race', update) as never);

    const showValueModal = vi.fn(
      (modal: { toJSON(): { components: { components: { custom_id: string }[] }[] } }) => {
        expect(
          modal
            .toJSON()
            .components.flatMap((row) => row.components.map((input) => input.custom_id)),
        ).toEqual(['value', 'deadline']);
        return Promise.resolve();
      },
    );
    await adapter.handle(
      selectInteraction(raidCustomId, 'Tombs of Amascut', update, showValueModal) as never,
    );
    expect(showValueModal).toHaveBeenCalledOnce();
  });

  it('rejects another member and expired sessions before creation', () => {
    const clock = new FakeClock();
    const competitions = new CompetitionStub();
    const handler = new CompetitionCreateCommandHandler(
      competitions,
      new ConfigurationStub(),
      new InMemoryCompetitionCreateSessionStore(clock),
      clock,
    );
    const start = handler.start('guild-one', 'manager-one');
    if (start.kind !== 'name_required') throw new Error('Expected competition name input.');

    expect(
      handler.submitName('guild-one', 'member-two', start.customId, 'Not allowed'),
    ).toMatchObject({
      kind: 'forbidden',
    });
    clock.advance(5 * 60 * 1_000);
    expect(
      handler.submitName('guild-one', 'manager-one', start.customId, 'Too late'),
    ).toMatchObject({
      kind: 'expired',
    });
    expect(competitions.requests).toEqual([]);
  });

  it('rejects stale step interactions without changing the selected definition', async () => {
    const competitions = new CompetitionStub();
    const handler = new CompetitionCreateCommandHandler(competitions, new ConfigurationStub());
    const start = handler.start('guild-one', 'manager-one');
    if (start.kind !== 'name_required') throw new Error('Expected competition name input.');
    const name = handler.submitName('guild-one', 'manager-one', start.customId, 'Mining week');
    if (name.kind !== 'type_selection') throw new Error('Expected type selection.');
    const type = handler.selectType('guild-one', 'manager-one', name.customId, 'most_skill_xp');
    if (type.kind !== 'metric_selection') throw new Error('Expected metric selection.');
    const metric = handler.selectMetric(
      'guild-one',
      'manager-one',
      type.customIdForGroup(0),
      'Mining',
    );
    if (metric.kind !== 'value_required') throw new Error('Expected duration input.');

    expect(
      handler.selectType('guild-one', 'manager-one', name.customId, 'most_boss_kc'),
    ).toMatchObject({ kind: 'invalid_flow' });
    expect(
      handler.selectMetric('guild-one', 'manager-one', type.customIdForGroup(0), 'Woodcutting'),
    ).toMatchObject({ kind: 'invalid_flow' });

    await handler.submitValue({
      customId: metric.customId,
      guildId: 'guild-one',
      hasAdministratorPermission: true,
      memberRoleIds: [],
      requesterDiscordUserId: 'manager-one',
      value: '86400',
    });

    expect(competitions.requests).toHaveLength(1);
    expect(competitions.requests[0]).toMatchObject({
      metric: { kind: 'skill', name: 'Mining' },
      type: 'most_skill_xp',
    });
  });

  it('keeps the full guided flow private and defers creation before editing the reply', async () => {
    const adapter = new DiscordCompetitionCreateCommandAdapter(
      new CompetitionCreateCommandHandler(new CompetitionStub(), new ConfigurationStub()),
    );
    let nameCustomId = '';
    const showNameModal = vi.fn((modal: { toJSON(): { custom_id: string } }) => {
      nameCustomId = modal.toJSON().custom_id;
      return Promise.resolve();
    });
    await adapter.handle(commandInteraction(showNameModal) as never);

    let typeCustomId = '';
    const reply = vi.fn(
      (response: { components: { components: { data: { custom_id: string } }[] }[] }) => {
        typeCustomId = response.components[0]?.components[0]?.data.custom_id ?? '';
        return Promise.resolve();
      },
    );
    await adapter.handle(nameModalInteraction(nameCustomId, reply) as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));

    let metricCustomId = '';
    const update = vi.fn(
      (response: { components: { components: { data: { custom_id: string } }[] }[] }) => {
        metricCustomId = response.components[0]?.components[0]?.data.custom_id ?? '';
        return Promise.resolve();
      },
    );
    await adapter.handle(selectInteraction(typeCustomId, 'most_skill_xp', update) as never);

    let valueCustomId = '';
    const showValueModal = vi.fn((modal: { toJSON(): { custom_id: string } }) => {
      valueCustomId = modal.toJSON().custom_id;
      return Promise.resolve();
    });
    await adapter.handle(
      selectInteraction(metricCustomId, 'Mining', update, showValueModal) as never,
    );

    const deferReply = vi.fn(() => Promise.resolve());
    const replies: { content?: string }[] = [];
    const editReply = vi.fn((reply: { content?: string }) => {
      replies.push(reply);
      return Promise.resolve();
    });
    await adapter.handle(valueModalInteraction(valueCustomId, deferReply, editReply) as never);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toContain('Created');
  });
});

class CompetitionStub {
  public readonly requests: CreateCompetitionRequest[] = [];

  public create(request: CreateCompetitionRequest): Promise<CreateCompetitionResult> {
    this.requests.push(request);
    const competition: CompetitionDraft = {
      createdAt: new Date('2026-08-07T00:00:00.000Z'),
      createdByDiscordUserId: request.createdByDiscordUserId,
      displayName: request.name.trim(),
      durationSeconds: request.durationSeconds ?? null,
      guildId: request.guildId,
      id: 'competition-one',
      metric: request.metric,
      normalizedName: request.name.trim().toLowerCase(),
      state: 'draft',
      targetValue: 'targetValue' in request ? request.targetValue : null,
      timezone: request.timezone,
      type: request.type,
      updatedAt: new Date('2026-08-07T00:00:00.000Z'),
    };
    return Promise.resolve({ kind: 'created', competition });
  }
}

class ConfigurationStub {
  public getOrCreate(): Promise<GuildConfiguration> {
    return Promise.resolve({
      administrativeLogChannelId: null,
      administrativeLogMode: 'standard',
      botManagerRoleId: null,
      competitionManagerRoleId: 'competition-manager',
      guildId: 'guild-one',
      modeEmojis: {},
      recapChannelId: null,
      recapEnabled: false,
      recapLocalTime: null,
      timezone: 'Europe/Helsinki',
    });
  }
}

class FakeClock {
  private value = new Date('2026-08-07T00:00:00.000Z');
  public now(): Date {
    return this.value;
  }
  public advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

function commandInteraction(showModal: ReturnType<typeof vi.fn>) {
  return {
    commandName: 'competition',
    guildId: 'guild-one',
    isChatInputCommand: () => true,
    options: { getSubcommand: () => 'create' },
    showModal,
    user: { id: 'manager-one' },
  };
}

function nameModalInteraction(customId: string, reply: ReturnType<typeof vi.fn>) {
  return {
    customId,
    fields: { getTextInputValue: () => 'Mining week' },
    guildId: 'guild-one',
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    reply,
    user: { id: 'manager-one' },
  };
}

function valueModalInteraction(
  customId: string,
  deferReply: ReturnType<typeof vi.fn>,
  editReply: ReturnType<typeof vi.fn>,
) {
  return {
    customId,
    fields: {
      fields: { get: () => undefined },
      getTextInputValue: () => '86400',
    },
    guildId: 'guild-one',
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    member: { roles: ['competition-manager'] },
    memberPermissions: { has: () => false },
    deferReply,
    editReply,
    user: { id: 'manager-one' },
  };
}

function selectInteraction(
  customId: string,
  value: string,
  update: ReturnType<typeof vi.fn>,
  showModal?: ReturnType<typeof vi.fn>,
) {
  return {
    customId,
    guildId: 'guild-one',
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    showModal: showModal ?? vi.fn(() => Promise.resolve()),
    update,
    user: { id: 'manager-one' },
    values: [value],
  };
}
