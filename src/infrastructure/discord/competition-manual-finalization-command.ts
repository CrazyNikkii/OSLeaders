import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { DiscordInteractionRegistrar } from './discord-interaction-dispatcher.js';

import {
  TimedCompetitionFinalizationService,
  type ManualTimedCompetitionFinalizationResult,
  type TimedCompetitionFinalizationPermissionEvaluator,
} from '../../features/competitions/finalize-timed-competition.js';

const PREFIX = 'osleaders:competition-finish';
const LIFETIME_MS = 5 * 60 * 1_000;
const PAGE_SIZE = 23;

interface Session {
  competitionId?: string;
  expiresAt: Date;
  guildId: string;
  page: number;
  requesterDiscordUserId: string;
}

export interface ManualCompetitionFinalizationChoices {
  listManuallyFinalizable(guildId: string): Promise<readonly { id: string; displayName: string }[]>;
}

export class CompetitionManualFinalizationCommandHandler {
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly finalizations: Pick<TimedCompetitionFinalizationService, 'finalizeManually'>,
    private readonly choices: ManualCompetitionFinalizationChoices,
    private readonly permissions: TimedCompetitionFinalizationPermissionEvaluator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async start(guildId: string | null, requesterDiscordUserId: string) {
    if (guildId === null) return failure('This command can only be used in a server.');
    const competitions = await this.choices.listManuallyFinalizable(guildId);
    if (competitions.length === 0)
      return failure('There are no active timed competitions to finish.');
    return this.selection(competitions, {
      expiresAt: new Date(this.now().getTime() + LIFETIME_MS),
      guildId,
      page: 0,
      requesterDiscordUserId,
    });
  }

  public async choose(request: {
    competitionId: string;
    customId: string;
    guildId: string | null;
    requesterDiscordUserId: string;
  }) {
    const session = this.consume(request.customId, request.guildId, request.requesterDiscordUserId);
    if (typeof session === 'string') return failure(session);
    if (session === undefined || request.guildId === null) return invalid();
    const choices = await this.choices.listManuallyFinalizable(request.guildId);
    if (request.competitionId === '__next_page__' || request.competitionId === '__previous_page__')
      return this.selection(choices, {
        ...session,
        page:
          request.competitionId === '__next_page__'
            ? session.page + 1
            : Math.max(0, session.page - 1),
      });
    const competition = choices.find((choice) => choice.id === request.competitionId);
    if (competition === undefined) return failure('That competition can no longer be finished.');
    return {
      customId: this.create({ ...session, competitionId: competition.id }),
      displayName: competition.displayName,
      kind: 'confirmation' as const,
    };
  }

  public async confirm(request: {
    customId: string;
    guildId: string | null;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }) {
    const session = this.consume(request.customId, request.guildId, request.requesterDiscordUserId);
    if (typeof session === 'string') return failure(session);
    if (session?.competitionId === undefined || request.guildId === null)
      return failure('This confirmation is no longer valid. Run `/competition finish` again.');
    return message(
      await this.finalizations.finalizeManually(
        {
          competitionId: session.competitionId,
          guildId: request.guildId,
          hasAdministratorPermission: request.hasAdministratorPermission,
          memberRoleIds: request.memberRoleIds,
          requesterDiscordUserId: request.requesterDiscordUserId,
        },
        this.permissions,
      ),
    );
  }

  private selection(
    competitions: readonly { id: string; displayName: string }[],
    session: Session,
  ) {
    const pageCount = Math.max(1, Math.ceil(competitions.length / PAGE_SIZE));
    const page = Math.min(session.page, pageCount - 1);
    return {
      competitions: competitions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
      customId: this.create({ ...session, page }),
      kind: 'selection' as const,
      page,
      pageCount,
    };
  }

  private create(session: Session): string {
    const id = randomUUID();
    this.sessions.set(id, session);
    return `${PREFIX}:${id}`;
  }

  private consume(
    customId: string,
    guildId: string | null,
    userId: string,
  ): Session | string | undefined {
    const id = customId.startsWith(`${PREFIX}:`) ? customId.slice(PREFIX.length + 1) : '';
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    this.sessions.delete(id);
    if (session.expiresAt <= this.now())
      return 'This confirmation expired. Run `/competition finish` again.';
    return session.guildId === guildId && session.requesterDiscordUserId === userId
      ? session
      : 'This interaction belongs to another member or server.';
  }
}

export class DiscordCompetitionManualFinalizationCommandAdapter {
  public constructor(private readonly handler: CompetitionManualFinalizationCommandHandler) {}

  public async handle(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName !== 'competition' ||
        interaction.options.getSubcommand() !== 'finish'
      )
        return;
      await interaction.reply({
        ...render(await this.handler.start(interaction.guildId, interaction.user.id)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(PREFIX)) {
      await interaction.deferUpdate();
      await interaction.editReply(
        render(
          await this.handler.choose({
            customId: interaction.customId,
            competitionId: interaction.values[0] ?? '',
            guildId: interaction.guildId,
            requesterDiscordUserId: interaction.user.id,
          }),
        ),
      );
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(PREFIX)) {
      await interaction.deferUpdate();
      await interaction.editReply(
        render(
          await this.handler.confirm({
            customId: interaction.customId,
            guildId: interaction.guildId,
            hasAdministratorPermission:
              interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
            memberRoleIds: memberRoleIds(interaction),
            requesterDiscordUserId: interaction.user.id,
          }),
        ),
      );
    }
  }
}

export function bindDiscordCompetitionManualFinalizationCommandAdapter(
  client: DiscordInteractionRegistrar,
  adapter: DiscordCompetitionManualFinalizationCommandAdapter,
  report: (error: unknown) => void,
  shouldHandle: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (
      shouldHandle(interaction) &&
      (interaction.isChatInputCommand() ||
        interaction.isStringSelectMenu() ||
        interaction.isButton())
    )
      void adapter.handle(interaction).catch(report);
  });
}

function render(result: unknown) {
  if (isSelection(result))
    return {
      content: 'Choose a timed competition to finish.',
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(result.customId)
            .setPlaceholder('Choose a timed competition to finish')
            .addOptions([
              ...result.competitions.map((competition) => ({
                label: competition.displayName,
                value: competition.id,
              })),
              ...(result.page > 0 ? [{ label: 'Previous page', value: '__previous_page__' }] : []),
              ...(result.page < result.pageCount - 1
                ? [{ label: 'Next page', value: '__next_page__' }]
                : []),
            ]),
        ),
      ],
    };
  if (isConfirmation(result))
    return {
      content: `Finish **${result.displayName}** now? Current Hiscores values will determine the final result.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(result.customId)
            .setLabel('Finish competition')
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    };
  return { content: (result as { message: string }).message, components: [] };
}

function message(result: ManualTimedCompetitionFinalizationResult) {
  switch (result.kind) {
    case 'finished':
      return failure('Competition final values were collected and its result is being delivered.');
    case 'finish_pending':
      return failure(
        'Competition finalization is pending because final values could not be fetched.',
      );
    case 'competition_not_found':
      return failure('That competition no longer exists in this server.');
    case 'forbidden':
      return failure('Only the competition creator or a competition manager can finish it.');
    case 'finalization_locked':
    case 'finish_locked':
      return failure(
        'This competition is already finishing or can no longer be finished manually.',
      );
  }
}
function failure(message: string) {
  return { kind: 'failed' as const, message };
}
function invalid() {
  return failure('This interaction is no longer valid. Run `/competition finish` again.');
}
function isSelection(value: unknown): value is {
  kind: 'selection';
  customId: string;
  competitions: readonly { id: string; displayName: string }[];
  page: number;
  pageCount: number;
} {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'selection'
  );
}
function isConfirmation(
  value: unknown,
): value is { kind: 'confirmation'; customId: string; displayName: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: string }).kind === 'confirmation'
  );
}
function memberRoleIds(interaction: ButtonInteraction): readonly string[] {
  const roles = interaction.member?.roles;
  return roles === undefined || Array.isArray(roles) ? (roles ?? []) : [...roles.cache.keys()];
}
