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
  type Client,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import {
  CompetitionCancellationService,
  type CompetitionCancellationResult,
} from '../../features/competitions/cancel-competition.js';

const PREFIX = 'osleaders:competition-cancel';
const LIFETIME_MS = 5 * 60 * 1_000;
interface Session {
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
  competitionId?: string;
  page?: number;
}
export interface CompetitionCancellationChoices {
  listCancellable(guildId: string): Promise<readonly { id: string; displayName: string }[]>;
}

export class CompetitionCancellationCommandHandler {
  private readonly sessions = new Map<string, Session>();
  public constructor(
    private readonly service: Pick<CompetitionCancellationService, 'cancel'>,
    private readonly choices: CompetitionCancellationChoices,
    private readonly now: () => Date = () => new Date(),
  ) {}
  public async start(guildId: string | null, requesterDiscordUserId: string) {
    if (guildId === null) return failure('This command can only be used in a server.');
    const competitions = await this.choices.listCancellable(guildId);
    if (competitions.length === 0)
      return failure('There are no competitions that can be cancelled in this server.');
    return this.selection(
      competitions,
      {
        guildId,
        requesterDiscordUserId,
        expiresAt: new Date(this.now().getTime() + LIFETIME_MS),
      },
      0,
    );
  }
  public async choose(request: {
    customId: string;
    competitionId: string;
    guildId: string | null;
    requesterDiscordUserId: string;
  }) {
    const session = this.consume(request.customId, request.guildId, request.requesterDiscordUserId);
    if (typeof session === 'string') return failure(session);
    if (session === undefined || request.guildId === null)
      return failure('This interaction is no longer valid. Run `/competition cancel` again.');
    const choices = await this.choices.listCancellable(request.guildId);
    if (request.competitionId === '__next_page__' || request.competitionId === '__previous_page__')
      return this.selection(
        choices,
        session,
        request.competitionId === '__next_page__'
          ? (session.page ?? 0) + 1
          : Math.max(0, (session.page ?? 0) - 1),
      );
    const competition = choices.find((choice) => choice.id === request.competitionId);
    if (competition === undefined) return failure('That competition can no longer be cancelled.');
    return {
      kind: 'confirmation' as const,
      customId: this.create({ ...session, competitionId: competition.id }),
      displayName: competition.displayName,
    };
  }
  public async confirm(request: {
    customId: string;
    guildId: string | null;
    requesterDiscordUserId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }) {
    const session = this.consume(request.customId, request.guildId, request.requesterDiscordUserId);
    if (typeof session === 'string') return failure(session);
    if (session?.competitionId === undefined || request.guildId === null)
      return failure('This confirmation is no longer valid. Run `/competition cancel` again.');
    return cancellationMessage(
      await this.service.cancel({
        competitionId: session.competitionId,
        guildId: request.guildId,
        hasAdministratorPermission: request.hasAdministratorPermission,
        memberRoleIds: request.memberRoleIds,
        requesterDiscordUserId: request.requesterDiscordUserId,
      }),
    );
  }
  private create(session: Session): string {
    const id = randomUUID();
    this.sessions.set(id, session);
    return `${PREFIX}:${id}`;
  }
  private selection(
    competitions: readonly { id: string; displayName: string }[],
    session: Session,
    requestedPage: number,
  ) {
    const pageCount = Math.max(1, Math.ceil(competitions.length / 23));
    const page = Math.min(requestedPage, pageCount - 1);
    return {
      kind: 'selection' as const,
      customId: this.create({ ...session, page }),
      competitions: competitions.slice(page * 23, (page + 1) * 23),
      page,
      pageCount,
    };
  }
  private consume(
    customId: string,
    guildId: string | null,
    userId: string,
  ):
    | Session
    | 'This confirmation expired. Run `/competition cancel` again.'
    | 'This interaction belongs to another member or server.'
    | undefined {
    const id = customId.startsWith(`${PREFIX}:`) ? customId.slice(PREFIX.length + 1) : '';
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    this.sessions.delete(id);
    if (session.expiresAt <= this.now())
      return 'This confirmation expired. Run `/competition cancel` again.';
    return session.guildId === guildId && session.requesterDiscordUserId === userId
      ? session
      : 'This interaction belongs to another member or server.';
  }
}

export class DiscordCompetitionCancellationCommandAdapter {
  public constructor(private readonly handler: CompetitionCancellationCommandHandler) {}
  public async handle(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName !== 'competition' ||
        interaction.options.getSubcommand() !== 'cancel'
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
            requesterDiscordUserId: interaction.user.id,
            hasAdministratorPermission:
              interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
            memberRoleIds: memberRoleIds(interaction),
          }),
        ),
      );
    }
  }
}
export function bindDiscordCompetitionCancellationCommandAdapter(
  client: Client,
  adapter: DiscordCompetitionCancellationCommandAdapter,
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
      content: 'Choose a competition to cancel.',
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(result.customId)
            .setPlaceholder('Choose a competition to cancel')
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
      content: `Cancel **${result.displayName}**? This cannot be undone.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(result.customId)
            .setLabel('Cancel competition')
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    };
  return { content: (result as { message: string }).message, components: [] };
}
function cancellationMessage(result: CompetitionCancellationResult) {
  switch (result.kind) {
    case 'cancelled':
      return failure(`Competition **${result.displayName}** was cancelled.`);
    case 'competition_not_found':
      return failure('That competition no longer exists in this server.');
    case 'forbidden':
      return failure('Only the competition creator or a competition manager can cancel it.');
    case 'cancellation_locked':
      return failure('This competition has already finished or was cancelled.');
  }
}
function failure(message: string) {
  return { kind: 'failed' as const, message };
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
