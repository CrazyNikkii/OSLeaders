import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import {
  COMPETITION_TYPES,
  CompetitionCreationService,
  type CompetitionMetric,
  type CompetitionType,
  type CreateCompetitionRequest,
  type CreateCompetitionResult,
} from '../../features/competitions/create-competition.js';
import type { GuildConfigurationService } from '../../features/guild-configuration/guild-configuration-service.js';
import { OSRS_BOSS_ACTIVITY_NAMES, OSRS_SKILL_NAMES } from '../hiscores/osrs-hiscore-catalog.js';
import { bossChoiceMenuRows } from './boss-choice-menu.js';

const COMMAND_NAME = 'competition';
const INTERACTION_PREFIX = 'osleaders:competition-create';
const NAME_INPUT_ID = 'name';
const VALUE_INPUT_ID = 'value';
const SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_PENDING_SESSIONS = 1_000;

export const competitionCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription('Create and manage competitions.')
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand.setName('create').setDescription('Create a competition draft.'),
    )
    .toJSON(),
] as const;

export interface CompetitionCreateClock {
  now(): Date;
}

export interface CompetitionCreateSession {
  expiresAt: Date;
  guildId: string;
  metric?: CompetitionMetric;
  name?: string;
  requesterDiscordUserId: string;
  step: 'name' | 'type' | 'metric' | 'value';
  type?: CompetitionType;
}

export interface CompetitionCreateSessionStore {
  create(session: CompetitionCreateSession): string;
  consume(
    sessionId: string,
    expected: Pick<CompetitionCreateSession, 'guildId' | 'requesterDiscordUserId'>,
  ): CompetitionCreateSession | 'expired' | 'mismatch' | undefined;
  update(
    sessionId: string,
    expected: Pick<CompetitionCreateSession, 'guildId' | 'requesterDiscordUserId'>,
    update: Partial<Pick<CompetitionCreateSession, 'metric' | 'name' | 'step' | 'type'>>,
  ): CompetitionCreateSession | 'expired' | 'mismatch' | undefined;
}

export class InMemoryCompetitionCreateSessionStore implements CompetitionCreateSessionStore {
  private readonly sessions = new Map<string, CompetitionCreateSession>();

  public constructor(
    private readonly clock: CompetitionCreateClock = { now: () => new Date() },
    private readonly maximumPendingSessions = MAX_PENDING_SESSIONS,
  ) {
    if (!Number.isSafeInteger(maximumPendingSessions) || maximumPendingSessions < 1) {
      throw new Error('maximumPendingSessions must be a positive safe integer.');
    }
  }

  public create(session: CompetitionCreateSession): string {
    this.pruneExpired();
    while (this.sessions.size >= this.maximumPendingSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  public consume(
    sessionId: string,
    expected: Pick<CompetitionCreateSession, 'guildId' | 'requesterDiscordUserId'>,
  ): CompetitionCreateSession | 'expired' | 'mismatch' | undefined {
    const session = this.get(sessionId, expected);
    if (typeof session === 'object') this.sessions.delete(sessionId);
    return session;
  }

  public update(
    sessionId: string,
    expected: Pick<CompetitionCreateSession, 'guildId' | 'requesterDiscordUserId'>,
    update: Partial<Pick<CompetitionCreateSession, 'metric' | 'name' | 'step' | 'type'>>,
  ): CompetitionCreateSession | 'expired' | 'mismatch' | undefined {
    const session = this.get(sessionId, expected);
    if (typeof session !== 'object') return session;
    const updated = { ...session, ...update };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  private get(
    sessionId: string,
    expected: Pick<CompetitionCreateSession, 'guildId' | 'requesterDiscordUserId'>,
  ): CompetitionCreateSession | 'expired' | 'mismatch' | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) {
      this.sessions.delete(sessionId);
      return 'expired';
    }
    if (
      session.guildId !== expected.guildId ||
      session.requesterDiscordUserId !== expected.requesterDiscordUserId
    ) {
      return 'mismatch';
    }
    return session;
  }

  private pruneExpired(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt.getTime() <= this.clock.now().getTime()) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

export type CompetitionCreateCommandResult =
  | { kind: 'name_required'; customId: string }
  | { kind: 'type_selection'; customId: string }
  | {
      kind: 'metric_selection';
      customIdForGroup: (groupIndex: number) => string;
      metric: 'boss' | 'skill';
    }
  | { kind: 'value_required'; customId: string; type: CompetitionType }
  | { kind: 'created'; competitionName: string }
  | { kind: 'failed'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid_flow'; message: string }
  | { kind: 'not_in_guild'; message: string };

export class CompetitionCreateCommandHandler {
  public constructor(
    private readonly competitions: Pick<CompetitionCreationService, 'create'>,
    private readonly configuration: Pick<GuildConfigurationService, 'getOrCreate'>,
    private readonly sessions: CompetitionCreateSessionStore = new InMemoryCompetitionCreateSessionStore(),
    private readonly clock: CompetitionCreateClock = { now: () => new Date() },
  ) {}

  public start(
    guildId: string | null,
    requesterDiscordUserId: string,
  ): Extract<CompetitionCreateCommandResult, { kind: 'name_required' | 'not_in_guild' }> {
    if (guildId === null) return notInGuild();
    const sessionId = this.sessions.create({
      expiresAt: new Date(this.clock.now().getTime() + SESSION_LIFETIME_MS),
      guildId,
      requesterDiscordUserId,
      step: 'name',
    });
    return { kind: 'name_required', customId: encode('name', sessionId) };
  }

  public submitName(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    name: string,
  ): CompetitionCreateCommandResult {
    const sessionId = decode(customId, 'name');
    const binding = bindingFor(guildId, requesterDiscordUserId);
    if (sessionId === undefined || binding === undefined) return invalid(guildId);
    const session = this.sessions.update(sessionId, binding, {});
    if (typeof session !== 'object') return sessionFailure(session);
    if (session.step !== 'name') return invalidFlow();
    this.sessions.update(sessionId, binding, { name, step: 'type' });
    return { kind: 'type_selection', customId: encode('type', sessionId) };
  }

  public selectType(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    type: string,
  ): CompetitionCreateCommandResult {
    const sessionId = decode(customId, 'type');
    const binding = bindingFor(guildId, requesterDiscordUserId);
    if (sessionId === undefined || binding === undefined || !isCompetitionType(type)) {
      return invalid(guildId);
    }
    const session = this.sessions.update(sessionId, binding, {});
    if (typeof session !== 'object') return sessionFailure(session);
    if (session.step !== 'type') return invalidFlow();
    this.sessions.update(sessionId, binding, { step: 'metric', type });
    const metric = type === 'most_skill_xp' || type === 'skill_xp_target_race' ? 'skill' : 'boss';
    return {
      kind: 'metric_selection',
      customIdForGroup: (groupIndex) => encode('metric', sessionId, groupIndex),
      metric,
    };
  }

  public selectMetric(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    metricName: string,
  ): CompetitionCreateCommandResult {
    const decoded = decodeMetric(customId);
    const binding = bindingFor(guildId, requesterDiscordUserId);
    if (decoded === undefined || binding === undefined) return invalid(guildId);
    const session = this.sessions.update(decoded.sessionId, binding, {});
    if (typeof session !== 'object') return sessionFailure(session);
    if (session.step !== 'metric') return invalidFlow();
    const metric = metricFor(session.type, metricName);
    if (metric === undefined) return invalid(guildId);
    this.sessions.update(decoded.sessionId, binding, { metric, step: 'value' });
    return {
      kind: 'value_required',
      customId: encode('value', decoded.sessionId),
      type: session.type!,
    };
  }

  public async submitValue(request: {
    customId: string;
    guildId: string | null;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
    value: string;
  }): Promise<CompetitionCreateCommandResult> {
    const sessionId = decode(request.customId, 'value');
    const binding = bindingFor(request.guildId, request.requesterDiscordUserId);
    if (sessionId === undefined || binding === undefined) return invalid(request.guildId);
    const session = this.sessions.consume(sessionId, binding);
    if (typeof session !== 'object') return sessionFailure(session);
    if (!isCompleteSession(session) || session.step !== 'value') {
      return invalidFlow();
    }
    const numericValue = parsePositiveInteger(request.value);
    if (numericValue === undefined) return invalidDefinition();
    const configuration = await this.configuration.getOrCreate(binding.guildId);
    const result = await this.competitions.create(
      createRequest({
        configurationTimezone: configuration.timezone,
        hasAdministratorPermission: request.hasAdministratorPermission,
        memberRoleIds: request.memberRoleIds,
        numericValue,
        requesterDiscordUserId: request.requesterDiscordUserId,
        session,
      }),
    );
    return creationResult(result);
  }
}

export class DiscordCompetitionCreateCommandAdapter {
  public constructor(private readonly handler: CompetitionCreateCommandHandler) {}

  public async handle(
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName !== COMMAND_NAME ||
        interaction.options.getSubcommand() !== 'create'
      )
        return;
      const result = this.handler.start(interaction.guildId, interaction.user.id);
      if (result.kind === 'name_required') {
        await interaction.showModal(nameModal(result.customId));
      } else {
        await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if ('isModalSubmit' in interaction && interaction.isModalSubmit()) {
      if (decode(interaction.customId, 'name') !== undefined) {
        await interaction.reply({
          ...response(
            this.handler.submitName(
              interaction.guildId,
              interaction.user.id,
              interaction.customId,
              interaction.fields.getTextInputValue(NAME_INPUT_ID),
            ),
          ),
          flags: MessageFlags.Ephemeral,
        });
      } else if (decode(interaction.customId, 'value') !== undefined) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply(
          response(
            await this.handler.submitValue({
              customId: interaction.customId,
              guildId: interaction.guildId,
              hasAdministratorPermission:
                interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
              memberRoleIds: memberRoleIds(interaction),
              requesterDiscordUserId: interaction.user.id,
              value: interaction.fields.getTextInputValue(VALUE_INPUT_ID),
            }),
          ),
        );
      }
      return;
    }
    if ('isStringSelectMenu' in interaction && interaction.isStringSelectMenu()) {
      const value = interaction.values[0] ?? '';
      if (decode(interaction.customId, 'type') !== undefined) {
        await interaction.update(
          response(
            this.handler.selectType(
              interaction.guildId,
              interaction.user.id,
              interaction.customId,
              value,
            ),
          ),
        );
      } else if (decodeMetric(interaction.customId) !== undefined) {
        const result = this.handler.selectMetric(
          interaction.guildId,
          interaction.user.id,
          interaction.customId,
          value,
        );
        if (result.kind === 'value_required') {
          await interaction.showModal(valueModal(result.customId, result.type));
        } else {
          await interaction.update(response(result));
        }
      }
    }
  }
}

export function bindDiscordCompetitionCreateCommandAdapter(
  client: Client,
  adapter: DiscordCompetitionCreateCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!shouldHandleInteraction(interaction)) return;
    if (
      interaction.isChatInputCommand() ||
      interaction.isModalSubmit() ||
      interaction.isStringSelectMenu()
    ) {
      void adapter.handle(interaction).catch(reportUnexpectedError);
    }
  });
}

function nameModal(customId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Create competition draft')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(NAME_INPUT_ID)
          .setLabel('Competition name')
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
}

function valueModal(customId: string, type: CompetitionType): ModalBuilder {
  const targetRace = type === 'skill_xp_target_race' || type === 'boss_kc_target_race';
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Competition details')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(VALUE_INPUT_ID)
          .setLabel(targetRace ? 'Target gain' : 'Duration in seconds')
          .setPlaceholder(targetRace ? 'For example: 1000000' : 'For example: 604800')
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
}

function response(result: CompetitionCreateCommandResult) {
  switch (result.kind) {
    case 'type_selection':
      return {
        content: 'Choose the competition type.',
        components: [
          select(
            result.customId,
            'Choose competition type',
            COMPETITION_TYPES.map((type) => ({ label: competitionTypeLabel(type), value: type })),
          ),
        ],
      };
    case 'metric_selection':
      return {
        content: result.metric === 'skill' ? 'Choose the skill.' : 'Choose the boss.',
        components:
          result.metric === 'skill'
            ? [
                select(
                  result.customIdForGroup(0),
                  'Choose skill',
                  OSRS_SKILL_NAMES.map((value) => ({ label: value, value })),
                ),
              ]
            : bossChoiceMenuRows(result.customIdForGroup),
      };
    case 'created':
      return {
        components: [],
        content: `Created the draft competition **${result.competitionName}**.`,
      };
    case 'value_required':
      return { components: [], content: 'Choose the competition metric again.' };
    case 'name_required':
      return { components: [], content: 'Run `/competition create` again.' };
    default:
      return { components: [], content: result.message };
  }
}

function select(
  customId: string,
  placeholder: string,
  options: readonly { label: string; value: string }[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions([...options]),
  );
}

function createRequest(input: {
  configurationTimezone: string;
  hasAdministratorPermission: boolean;
  memberRoleIds: readonly string[];
  numericValue: bigint;
  requesterDiscordUserId: string;
  session: CompletedCompetitionCreateSession;
}): CreateCompetitionRequest {
  const base = {
    createdByDiscordUserId: input.requesterDiscordUserId,
    guildId: input.session.guildId,
    hasAdministratorPermission: input.hasAdministratorPermission,
    memberRoleIds: input.memberRoleIds,
    name: input.session.name,
    timezone: input.configurationTimezone,
  };
  switch (input.session.type) {
    case 'most_skill_xp':
      if (input.session.metric.kind !== 'skill')
        throw new Error('A skill competition requires a skill metric.');
      return {
        ...base,
        durationSeconds: Number(input.numericValue),
        metric: input.session.metric,
        type: input.session.type,
      };
    case 'most_boss_kc':
      if (input.session.metric.kind !== 'boss')
        throw new Error('A boss competition requires a boss metric.');
      return {
        ...base,
        durationSeconds: Number(input.numericValue),
        metric: input.session.metric,
        type: input.session.type,
      };
    case 'skill_xp_target_race':
      if (input.session.metric.kind !== 'skill')
        throw new Error('A skill competition requires a skill metric.');
      return {
        ...base,
        metric: input.session.metric,
        targetValue: input.numericValue,
        type: input.session.type,
      };
    case 'boss_kc_target_race':
      if (input.session.metric.kind !== 'boss')
        throw new Error('A boss competition requires a boss metric.');
      return {
        ...base,
        metric: input.session.metric,
        targetValue: input.numericValue,
        type: input.session.type,
      };
  }
}

type CompletedCompetitionCreateSession = CompetitionCreateSession & {
  metric: CompetitionMetric;
  name: string;
  type: CompetitionType;
};

function isCompleteSession(
  session: CompetitionCreateSession,
): session is CompletedCompetitionCreateSession {
  return session.name !== undefined && session.type !== undefined && session.metric !== undefined;
}

function creationResult(result: CreateCompetitionResult): CompetitionCreateCommandResult {
  switch (result.kind) {
    case 'created':
      return { kind: 'created', competitionName: result.competition.displayName };
    case 'forbidden':
      return {
        kind: 'forbidden',
        message:
          'You need Discord Administrator permission or the competition-manager role to create competitions.',
      };
    case 'name_taken':
      return {
        kind: 'failed',
        message: 'A competition with that name already exists in this server.',
      };
    case 'invalid_definition':
      return invalidDefinition();
  }
}

function metricFor(type: CompetitionType | undefined, name: string): CompetitionMetric | undefined {
  if (type === 'most_skill_xp' || type === 'skill_xp_target_race') {
    return OSRS_SKILL_NAMES.includes(name as (typeof OSRS_SKILL_NAMES)[number])
      ? { kind: 'skill', name }
      : undefined;
  }
  return type !== undefined &&
    OSRS_BOSS_ACTIVITY_NAMES.includes(name as (typeof OSRS_BOSS_ACTIVITY_NAMES)[number])
    ? { kind: 'boss', name }
    : undefined;
}

function parsePositiveInteger(value: string): bigint | undefined {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return undefined;
  try {
    return BigInt(normalized);
  } catch {
    return undefined;
  }
}

function memberRoleIds(interaction: ModalSubmitInteraction): readonly string[] {
  const roles = interaction.member?.roles;
  return roles === undefined ? [] : Array.isArray(roles) ? roles : [...roles.cache.keys()];
}

function competitionTypeLabel(type: CompetitionType): string {
  switch (type) {
    case 'most_skill_xp':
      return 'Most skill XP gained';
    case 'skill_xp_target_race':
      return 'Skill XP target race';
    case 'most_boss_kc':
      return 'Most boss KC gained';
    case 'boss_kc_target_race':
      return 'Boss KC target race';
  }
}

function encode(kind: 'name' | 'type' | 'value', sessionId: string): string;
function encode(kind: 'metric', sessionId: string, groupIndex: number): string;
function encode(
  kind: 'name' | 'type' | 'value' | 'metric',
  sessionId: string,
  groupIndex?: number,
): string {
  return kind === 'metric'
    ? `${INTERACTION_PREFIX}:${kind}:${groupIndex}:${sessionId}`
    : `${INTERACTION_PREFIX}:${kind}:${sessionId}`;
}

function decode(customId: string, kind: 'name' | 'type' | 'value'): string | undefined {
  const prefix = `${INTERACTION_PREFIX}:${kind}:`;
  const sessionId = customId.startsWith(prefix) ? customId.slice(prefix.length) : '';
  return sessionId.length > 0 && !sessionId.includes(':') ? sessionId : undefined;
}

function decodeMetric(customId: string): { groupIndex: number; sessionId: string } | undefined {
  const prefix = `${INTERACTION_PREFIX}:metric:`;
  if (!customId.startsWith(prefix)) return undefined;
  const [groupIndex, sessionId, extra] = customId.slice(prefix.length).split(':');
  return extra === undefined &&
    /^\d+$/.test(groupIndex ?? '') &&
    sessionId !== undefined &&
    sessionId.length > 0
    ? { groupIndex: Number(groupIndex), sessionId }
    : undefined;
}

function isCompetitionType(value: string): value is CompetitionType {
  return (COMPETITION_TYPES as readonly string[]).includes(value);
}

function bindingFor(guildId: string | null, requesterDiscordUserId: string) {
  return guildId === null ? undefined : { guildId, requesterDiscordUserId };
}

function notInGuild(): Extract<CompetitionCreateCommandResult, { kind: 'not_in_guild' }> {
  return { kind: 'not_in_guild', message: 'This command can only be used in a Discord server.' };
}

function invalid(guildId: string | null): CompetitionCreateCommandResult {
  return guildId === null
    ? notInGuild()
    : { kind: 'forbidden', message: 'You are not allowed to use this competition creation flow.' };
}

function invalidDefinition(): Extract<CompetitionCreateCommandResult, { kind: 'failed' }> {
  return {
    kind: 'failed',
    message:
      'Use a positive whole number within the supported competition limits, then run `/competition create` again.',
  };
}

function invalidFlow(): Extract<CompetitionCreateCommandResult, { kind: 'invalid_flow' }> {
  return {
    kind: 'invalid_flow',
    message: 'This competition creation flow is no longer valid. Run `/competition create` again.',
  };
}

function sessionFailure(
  failure: 'expired' | 'mismatch' | undefined,
): CompetitionCreateCommandResult {
  return failure === 'expired'
    ? {
        kind: 'expired',
        message: 'This competition creation flow has expired. Run `/competition create` again.',
      }
    : { kind: 'forbidden', message: 'You are not allowed to use this competition creation flow.' };
}
