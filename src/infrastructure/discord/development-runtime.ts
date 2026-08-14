import { Client, Events, GatewayIntentBits } from 'discord.js';
import { randomUUID } from 'node:crypto';

import { AccountModeValidator } from '../../features/accounts/validate-account-mode.js';
import { MemberPresenceService } from '../../features/accounts/member-presence.js';
import { AuditService } from '../../features/audit/audit-service.js';
import { SkillLookupService } from '../../features/lookups/skill-lookup.js';
import { SkillLeaderboardService } from '../../features/leaderboards/skill-leaderboard.js';
import { BossLeaderboardService } from '../../features/leaderboards/boss-leaderboard.js';
import { BossLookupService } from '../../features/lookups/boss-lookup.js';
import { DailyRecapCollectionService } from '../../features/recaps/daily-recap-collection.js';
import { DailyRecapCompetitionSummaryService } from '../../features/recaps/active-competition-recap-summary.js';
import { DailyRecapPreviewService } from '../../features/recaps/daily-recap-presentation.js';
import { PreviewDailyRecapService } from '../../features/recaps/preview-daily-recap.js';
import { ManualDailyRecapSendService } from '../../features/recaps/send-daily-recap.js';
import { DailyRecapDeliveryService } from '../../features/recaps/deliver-daily-recap.js';
import { ConfigureDailyRecapService } from '../../features/recaps/configure-daily-recap.js';
import { AutomaticDailyRecapSchedulingService } from '../../features/recaps/schedule-automatic-daily-recaps.js';
import { AutomaticDailyRecapCollectionService } from '../../features/recaps/collect-automatic-daily-recap.js';
import { DailyRecapFailureAuditService } from '../../features/recaps/report-daily-recap-failures.js';
import { CompetitionCreationService } from '../../features/competitions/create-competition.js';
import { CompetitionDraftParticipationService } from '../../features/competitions/manage-draft-participation.js';
import { CompetitionStandingsService } from '../../features/competitions/competition-standings.js';
import { CompetitionResultsHistoryService } from '../../features/competitions/competition-results-history.js';
import { TargetRaceClaimService } from '../../features/competitions/claim-target-race.js';
import { TargetRaceDeadlineFinalizationService } from '../../features/competitions/finalize-target-race-deadline.js';
import { TimedCompetitionFinalizationService } from '../../features/competitions/finalize-timed-competition.js';
import { TargetRaceDeadlineFailureAuditService } from '../../features/competitions/report-target-race-deadline-failures.js';
import { TimedCompetitionFinalizationFailureAuditService } from '../../features/competitions/report-timed-competition-finalization-failures.js';
import { ConfigureCompetitionChannelService } from '../../features/competitions/configure-competition-channel.js';
import { CompetitionResultDeliveryService } from '../../features/competitions/deliver-competition-result.js';
import { CompetitionRoleLifecycleService } from '../../features/competitions/manage-competition-role.js';
import { CompetitionRoleFailureAuditService } from '../../features/competitions/report-competition-role-failures.js';
import { CompetitionCancellationService } from '../../features/competitions/cancel-competition.js';
import { createErrorReferenceId } from '../../features/audit/error-reference.js';
import { GuildConfigurationService } from '../../features/guild-configuration/guild-configuration-service.js';
import { GuildPermissionService } from '../../features/guild-configuration/guild-permission-service.js';
import type { RuntimeConfiguration } from '../config/runtime-environment.js';
import { createDatabaseConnection, type DatabaseConnection } from '../database/connection.js';
import { PostgresAccountRegistrationRepository } from '../database/postgres-account-registration-repository.js';
import { PostgresGuildConfigurationRepository } from '../database/postgres-guild-configuration-repository.js';
import { PostgresDailyRecapCollectionRepository } from '../database/postgres-daily-recap-collection-repository.js';
import { PostgresManualDailyRecapSendRepository } from '../database/postgres-manual-daily-recap-send-repository.js';
import { PostgresDailyRecapDeliveryRepository } from '../database/postgres-daily-recap-delivery-repository.js';
import { PostgresAutomaticDailyRecapScheduleRepository } from '../database/postgres-automatic-daily-recap-schedule-repository.js';
import { PostgresAutomaticDailyRecapCollectionRepository } from '../database/postgres-automatic-daily-recap-collection-repository.js';
import { PostgresCompetitionCreationRepository } from '../database/postgres-competition-creation-repository.js';
import { PostgresCompetitionDraftParticipationRepository } from '../database/postgres-competition-draft-participation-repository.js';
import { PostgresCompetitionStartRepository } from '../database/postgres-competition-start-repository.js';
import { PostgresCompetitionStartDeliveryRepository } from '../database/postgres-competition-start-delivery-repository.js';
import { PostgresCompetitionStandingsRepository } from '../database/postgres-competition-standings-repository.js';
import { PostgresCompetitionResultsHistoryRepository } from '../database/postgres-competition-results-history-repository.js';
import { PostgresTargetRaceClaimRepository } from '../database/postgres-target-race-claim-repository.js';
import { PostgresTargetRaceDeadlineFinalizationRepository } from '../database/postgres-target-race-deadline-finalization-repository.js';
import { PostgresTimedCompetitionFinalizationRepository } from '../database/postgres-timed-competition-finalization-repository.js';
import { PostgresCompetitionResultDeliveryRepository } from '../database/postgres-competition-result-delivery-repository.js';
import { PostgresCompetitionRoleRepository } from '../database/postgres-competition-role-repository.js';
import { PostgresCompetitionCancellationRepository } from '../database/postgres-competition-cancellation-repository.js';
import { OsrsHiscoreHttpClient } from '../hiscores/osrs-hiscore-http-client.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../hiscores/osrs-hiscore-catalog.js';
import { StdoutStructuredLocalLogger } from '../logging/structured-local-logger.js';
import { createRuntimeAuditContextSanitizer } from '../logging/runtime-audit-context-sanitizer.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';
import {
  bindDiscordAccountCommandAdapter,
  createAccountDefaultSelectionCommandHandler,
  createAccountModeCommandHandler,
  createAccountRenameCommandHandler,
  createAccountRegistrationCommandHandler,
  createAccountRemovalCommandHandler,
  createDiscordAccountCommandAdapter,
} from './account-command-foundation.js';
import {
  bindDiscordSkillLookupCommandAdapter,
  createSkillLookupCommandHandler,
  DiscordSkillLookupCommandAdapter,
} from './skill-lookup-command.js';
import {
  bindDiscordSkillLeaderboardCommandAdapter,
  DiscordSkillLeaderboardCommandAdapter,
  SkillLeaderboardCommandHandler,
} from './skill-leaderboard-command.js';
import {
  bindDiscordBossLeaderboardCommandAdapter,
  BossLeaderboardCommandHandler,
  DiscordBossLeaderboardCommandAdapter,
} from './boss-leaderboard-command.js';
import {
  bindDiscordBossLookupCommandAdapter,
  createBossLookupCommandHandler,
  DiscordBossLookupCommandAdapter,
} from './boss-lookup-command.js';
import {
  bindDiscordOneTimeSkillLookupCommandAdapter,
  DiscordOneTimeSkillLookupCommandAdapter,
  OneTimeSkillLookupCommandHandler,
} from './one-time-skill-lookup-command.js';
import {
  bindDiscordOneTimeBossLookupCommandAdapter,
  DiscordOneTimeBossLookupCommandAdapter,
  OneTimeBossLookupCommandHandler,
} from './one-time-boss-lookup-command.js';
import {
  bindDiscordDailyRecapPreviewCommandAdapter,
  DiscordDailyRecapPreviewCommandAdapter,
} from './daily-recap-preview-command.js';
import {
  bindDiscordManualDailyRecapSendCommandAdapter,
  DiscordManualDailyRecapSendCommandAdapter,
} from './manual-daily-recap-send-command.js';
import { DiscordDailyRecapPublisher } from './daily-recap-discord-publisher.js';
import { DiscordDailyRecapFailureAuditPublisher } from './daily-recap-failure-audit-publisher.js';
import {
  InProcessDailyRecapDeliveryRecoveryScheduler,
  type DailyRecapDeliveryRecoveryScheduler,
} from './daily-recap-delivery-recovery-scheduler.js';
import {
  InProcessAutomaticDailyRecapSchedulingScheduler,
  type AutomaticDailyRecapSchedulingScheduler,
} from './automatic-daily-recap-scheduling-scheduler.js';
import {
  InProcessAutomaticDailyRecapCollectionScheduler,
  type AutomaticDailyRecapCollectionScheduler,
} from './automatic-daily-recap-collection-scheduler.js';
import {
  bindDiscordDailyRecapConfigurationCommandAdapter,
  DiscordDailyRecapConfigurationCommandAdapter,
} from './daily-recap-configuration-command.js';
import {
  bindDiscordMemberPresenceEventAdapter,
  DiscordMemberPresenceEventAdapter,
} from './member-presence-events.js';
import {
  bindDiscordCompetitionCreateCommandAdapter,
  CompetitionCreateCommandHandler,
  DiscordCompetitionCreateCommandAdapter,
} from './competition-create-command.js';
import {
  bindDiscordCompetitionDraftParticipationCommandAdapter,
  CompetitionDraftParticipationCommandHandler,
  DiscordCompetitionDraftParticipationCommandAdapter,
} from './competition-draft-participation-command.js';
import {
  bindDiscordCompetitionStartCommandAdapter,
  CompetitionStartCommandHandler,
  DiscordCompetitionStartCommandAdapter,
} from './competition-start-command.js';
import { CompetitionStartService } from '../../features/competitions/start-competition.js';
import { CompetitionStartAnnouncementDeliveryService } from '../../features/competitions/deliver-competition-start-announcement.js';
import { DiscordCompetitionStartAnnouncer } from './competition-start-discord-publisher.js';
import {
  InProcessCompetitionStartDeliveryRecoveryScheduler,
  type CompetitionStartDeliveryRecoveryScheduler,
} from './competition-start-delivery-recovery-scheduler.js';
import { CompetitionStartFailureAuditService } from '../../features/competitions/report-competition-start-failures.js';
import {
  InProcessCompetitionStartRetryScheduler,
  type CompetitionStartRetryScheduler,
} from './competition-start-retry-scheduler.js';
import { InProcessTargetRaceDeadlineFinalizationScheduler } from './target-race-deadline-finalization-scheduler.js';
import { InProcessTimedCompetitionFinalizationScheduler } from './timed-competition-finalization-scheduler.js';
import { DiscordCompetitionStartFailureAuditPublisher } from './competition-start-failure-audit-publisher.js';
import { DiscordInteractionDispatcher } from './discord-interaction-dispatcher.js';
import {
  bindDiscordCompetitionScheduleCommandAdapter,
  CompetitionScheduleCommandHandler,
  DiscordCompetitionScheduleCommandAdapter,
} from './competition-schedule-command.js';
import {
  bindDiscordCompetitionStandingsCommandAdapter,
  CompetitionStandingsCommandHandler,
  DiscordCompetitionStandingsCommandAdapter,
} from './competition-standings-command.js';
import {
  bindDiscordCompetitionResultsHistoryCommandAdapter,
  CompetitionResultsHistoryCommandHandler,
  DiscordCompetitionResultsHistoryCommandAdapter,
} from './competition-results-history-command.js';
import {
  bindDiscordCompetitionTargetRaceClaimCommandAdapter,
  CompetitionTargetRaceClaimCommandHandler,
  DiscordCompetitionTargetRaceClaimCommandAdapter,
} from './competition-target-race-claim-command.js';
import { CompetitionSchedulingService } from '../../features/competitions/schedule-competition.js';
import { PostgresCompetitionSchedulingRepository } from '../database/postgres-competition-scheduling-repository.js';
import { DiscordCompetitionResultPublisher } from './competition-result-discord-publisher.js';
import {
  InProcessCompetitionResultDeliveryRecoveryScheduler,
  type CompetitionResultDeliveryRecoveryScheduler,
} from './competition-result-delivery-recovery-scheduler.js';
import { DiscordCompetitionRolePublisher } from './competition-role-discord-publisher.js';
import { DiscordCompetitionRoleFailurePublisher } from './competition-role-failure-publisher.js';
import {
  InProcessCompetitionRoleRecoveryScheduler,
  type CompetitionRoleRecoveryScheduler,
} from './competition-role-recovery-scheduler.js';
import {
  bindDiscordCompetitionChannelConfigurationCommandAdapter,
  DiscordCompetitionChannelConfigurationCommandAdapter,
} from './competition-channel-configuration-command.js';
import {
  bindDiscordCompetitionCancellationCommandAdapter,
  CompetitionCancellationCommandHandler,
  DiscordCompetitionCancellationCommandAdapter,
} from './competition-cancellation-command.js';
import {
  bindDiscordCompetitionManualFinalizationCommandAdapter,
  CompetitionManualFinalizationCommandHandler,
  DiscordCompetitionManualFinalizationCommandAdapter,
} from './competition-manual-finalization-command.js';

export interface DevelopmentDiscordRuntime {
  close(): Promise<void>;
}

export interface DevelopmentDiscordRuntimeDependencies {
  createClient(): Client;
  createDatabaseConnection(configuration: RuntimeConfiguration['database']): DatabaseConnection;
  createLogger(): StructuredLocalLogger;
  createDailyRecapDeliveryRecoveryScheduler(
    delivery: DailyRecapDeliveryService,
    logger: StructuredLocalLogger,
  ): DailyRecapDeliveryRecoveryScheduler;
  createAutomaticDailyRecapSchedulingScheduler(
    schedules: AutomaticDailyRecapSchedulingService,
    logger: StructuredLocalLogger,
  ): AutomaticDailyRecapSchedulingScheduler;
  createAutomaticDailyRecapCollectionScheduler(
    collection: AutomaticDailyRecapCollectionService,
    logger: StructuredLocalLogger,
  ): AutomaticDailyRecapCollectionScheduler;
  createCompetitionStartRetryScheduler(
    starts: CompetitionStartService,
    logger: StructuredLocalLogger,
  ): CompetitionStartRetryScheduler;
  createCompetitionStartDeliveryRecoveryScheduler?(
    deliveries: CompetitionStartAnnouncementDeliveryService,
    logger: StructuredLocalLogger,
  ): CompetitionStartDeliveryRecoveryScheduler;
  createCompetitionResultDeliveryRecoveryScheduler?(
    deliveries: CompetitionResultDeliveryService,
    logger: StructuredLocalLogger,
  ): CompetitionResultDeliveryRecoveryScheduler;
  createCompetitionRoleRecoveryScheduler?(
    roles: CompetitionRoleLifecycleService,
    logger: StructuredLocalLogger,
  ): CompetitionRoleRecoveryScheduler;
  createTargetRaceDeadlineFinalizationScheduler?(
    finalizations: TargetRaceDeadlineFinalizationService,
    logger: StructuredLocalLogger,
    claims: TargetRaceClaimService,
  ): InProcessTargetRaceDeadlineFinalizationScheduler;
  createTimedCompetitionFinalizationScheduler?(
    finalizations: TimedCompetitionFinalizationService,
    logger: StructuredLocalLogger,
  ): InProcessTimedCompetitionFinalizationScheduler;
}

const defaultDependencies: DevelopmentDiscordRuntimeDependencies = {
  createClient: () =>
    new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] }),
  createDatabaseConnection,
  createLogger: () => new StdoutStructuredLocalLogger(),
  createDailyRecapDeliveryRecoveryScheduler: (delivery, logger) =>
    new InProcessDailyRecapDeliveryRecoveryScheduler(delivery, logger),
  createAutomaticDailyRecapSchedulingScheduler: (schedules, logger) =>
    new InProcessAutomaticDailyRecapSchedulingScheduler(schedules, logger),
  createAutomaticDailyRecapCollectionScheduler: (collection, logger) =>
    new InProcessAutomaticDailyRecapCollectionScheduler(collection, logger),
  createCompetitionStartRetryScheduler: (starts, logger) =>
    new InProcessCompetitionStartRetryScheduler(starts, logger),
  createCompetitionStartDeliveryRecoveryScheduler: (deliveries, logger) =>
    new InProcessCompetitionStartDeliveryRecoveryScheduler(deliveries, logger),
  createCompetitionResultDeliveryRecoveryScheduler: (deliveries, logger) =>
    new InProcessCompetitionResultDeliveryRecoveryScheduler(deliveries, logger),
  createCompetitionRoleRecoveryScheduler: (roles, logger) =>
    new InProcessCompetitionRoleRecoveryScheduler(roles, logger),
  createTargetRaceDeadlineFinalizationScheduler: (finalizations, logger, claims) =>
    new InProcessTargetRaceDeadlineFinalizationScheduler(finalizations, logger, claims),
  createTimedCompetitionFinalizationScheduler: (finalizations, logger) =>
    new InProcessTimedCompetitionFinalizationScheduler(finalizations, logger),
};

export async function startDevelopmentDiscordRuntime(
  configuration: RuntimeConfiguration,
  dependencies: DevelopmentDiscordRuntimeDependencies = defaultDependencies,
): Promise<DevelopmentDiscordRuntime> {
  const logger = dependencies.createLogger();
  const auditContextSanitizer = createRuntimeAuditContextSanitizer(configuration);
  const audit = new AuditService(logger, auditContextSanitizer);
  const connection = dependencies.createDatabaseConnection(configuration.database);
  const client = dependencies.createClient();
  let interactionDispatcher: DiscordInteractionDispatcher | undefined;

  try {
    await connection.pool.query('SELECT 1');

    const accountRepository = new PostgresAccountRegistrationRepository(connection.database);
    const memberPresenceAdapter = new DiscordMemberPresenceEventAdapter(
      new MemberPresenceService(accountRepository),
    );
    const configurationRepository = new PostgresGuildConfigurationRepository(connection.database);
    const configurationService = new GuildConfigurationService(configurationRepository);
    const permissions = new GuildPermissionService(configurationRepository);
    const hiscores = new OsrsHiscoreHttpClient();
    const accountModeValidator = new AccountModeValidator(hiscores, OSRS_MODE_FETCH_STRATEGIES);
    const adapter = createDiscordAccountCommandAdapter(
      createAccountRemovalCommandHandler(accountRepository, permissions),
      createAccountDefaultSelectionCommandHandler(accountRepository, permissions),
      createAccountRegistrationCommandHandler(
        accountRepository,
        accountModeValidator,
        configurationService,
        permissions,
      ),
      createAccountRenameCommandHandler(
        accountRepository,
        accountModeValidator,
        audit,
        permissions,
      ),
      createAccountModeCommandHandler(accountRepository, accountModeValidator, audit, permissions),
      configurationService,
    );
    const skillLookupAdapter = new DiscordSkillLookupCommandAdapter(
      createSkillLookupCommandHandler(
        accountRepository,
        new SkillLookupService(accountRepository, hiscores),
      ),
    );
    const oneTimeSkillLookupAdapter = new DiscordOneTimeSkillLookupCommandAdapter(
      new OneTimeSkillLookupCommandHandler(new SkillLookupService(accountRepository, hiscores)),
    );
    const oneTimeBossLookupAdapter = new DiscordOneTimeBossLookupCommandAdapter(
      new OneTimeBossLookupCommandHandler(new BossLookupService(accountRepository, hiscores)),
    );
    const skillLeaderboardAdapter = new DiscordSkillLeaderboardCommandAdapter(
      new SkillLeaderboardCommandHandler({
        skillLeaderboard: new SkillLeaderboardService(accountRepository, hiscores),
      }),
    );
    const bossLeaderboardAdapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler({
        bossLeaderboard: new BossLeaderboardService(accountRepository, hiscores),
      }),
    );
    const bossLookupAdapter = new DiscordBossLookupCommandAdapter(
      createBossLookupCommandHandler(
        accountRepository,
        new BossLookupService(accountRepository, hiscores),
      ),
    );
    const competitionStandingsRepository = new PostgresCompetitionStandingsRepository(
      connection.database,
    );
    const competitionStandings = new CompetitionStandingsService(
      competitionStandingsRepository,
      hiscores,
    );
    const recapCompetitionSummaries = new DailyRecapCompetitionSummaryService(
      competitionStandingsRepository,
      competitionStandings,
    );
    const dailyRecapPreviewAdapter = new DiscordDailyRecapPreviewCommandAdapter(
      new PreviewDailyRecapService(
        new DailyRecapPreviewService(
          new DailyRecapCollectionService(
            new PostgresDailyRecapCollectionRepository(connection.database),
            hiscores,
          ),
          recapCompetitionSummaries,
        ),
      ),
    );
    const delivery = new DailyRecapDeliveryService(
      new PostgresDailyRecapDeliveryRepository(connection.database),
      new DiscordDailyRecapPublisher(client),
    );
    const failureAudit = new DailyRecapFailureAuditService(
      audit,
      new DiscordDailyRecapFailureAuditPublisher(client, configurationService),
    );
    const manualDailyRecapSendAdapter = new DiscordManualDailyRecapSendCommandAdapter(
      new ManualDailyRecapSendService(
        new PostgresManualDailyRecapSendRepository(connection.database),
        new DailyRecapCollectionService(
          new PostgresDailyRecapCollectionRepository(connection.database),
          hiscores,
        ),
        undefined,
        failureAudit,
        recapCompetitionSummaries,
      ),
      delivery,
      permissions,
    );
    const deliveryRecoveryScheduler = dependencies.createDailyRecapDeliveryRecoveryScheduler(
      delivery,
      logger,
    );
    const automaticSchedulingScheduler = dependencies.createAutomaticDailyRecapSchedulingScheduler(
      new AutomaticDailyRecapSchedulingService(
        new PostgresAutomaticDailyRecapScheduleRepository(connection.database),
      ),
      logger,
    );
    const automaticCollectionScheduler = dependencies.createAutomaticDailyRecapCollectionScheduler(
      new AutomaticDailyRecapCollectionService(
        new PostgresAutomaticDailyRecapCollectionRepository(connection.database),
        new DailyRecapCollectionService(
          new PostgresDailyRecapCollectionRepository(connection.database),
          hiscores,
        ),
        undefined,
        failureAudit,
        recapCompetitionSummaries,
      ),
      logger,
    );
    const dailyRecapConfigurationAdapter = new DiscordDailyRecapConfigurationCommandAdapter(
      new ConfigureDailyRecapService(configurationRepository, permissions),
    );
    const competitionCreateAdapter = new DiscordCompetitionCreateCommandAdapter(
      new CompetitionCreateCommandHandler(
        new CompetitionCreationService(
          new PostgresCompetitionCreationRepository(connection.database),
          permissions,
          randomUUID,
        ),
        configurationService,
      ),
    );
    const competitionParticipationRepository = new PostgresCompetitionDraftParticipationRepository(
      connection.database,
    );
    const competitionDraftParticipationAdapter =
      new DiscordCompetitionDraftParticipationCommandAdapter(
        new CompetitionDraftParticipationCommandHandler(
          new CompetitionDraftParticipationService(
            competitionParticipationRepository,
            permissions,
            randomUUID,
          ),
          competitionParticipationRepository,
          accountRepository,
        ),
      );
    const competitionStartRepository = new PostgresCompetitionStartRepository(connection.database);
    const competitionStartDelivery = new CompetitionStartAnnouncementDeliveryService(
      new PostgresCompetitionStartDeliveryRepository(connection.database),
      new DiscordCompetitionStartAnnouncer(
        client,
        new PostgresCompetitionRoleRepository(connection.database),
      ),
    );
    const competitionStartService = new CompetitionStartService(
      competitionStartRepository,
      permissions,
      hiscores,
      undefined,
      new CompetitionStartFailureAuditService(
        audit,
        new DiscordCompetitionStartFailureAuditPublisher(client, configurationService),
      ),
      competitionStartDelivery,
    );
    const competitionStartAdapter = new DiscordCompetitionStartCommandAdapter(
      new CompetitionStartCommandHandler(competitionStartService, competitionStartRepository),
    );
    const competitionCancellationRepository = new PostgresCompetitionCancellationRepository(
      connection.database,
    );
    const competitionCancellationAdapter = new DiscordCompetitionCancellationCommandAdapter(
      new CompetitionCancellationCommandHandler(
        new CompetitionCancellationService(competitionCancellationRepository, permissions, audit),
        competitionCancellationRepository,
      ),
    );
    const competitionStartRetryScheduler = dependencies.createCompetitionStartRetryScheduler(
      competitionStartService,
      logger,
    );
    const competitionStartDeliveryRecoveryScheduler =
      dependencies.createCompetitionStartDeliveryRecoveryScheduler?.(
        competitionStartDelivery,
        logger,
      );
    const competitionSchedulingRepository = new PostgresCompetitionSchedulingRepository(
      connection.database,
    );
    const competitionScheduleAdapter = new DiscordCompetitionScheduleCommandAdapter(
      new CompetitionScheduleCommandHandler(
        new CompetitionSchedulingService(competitionSchedulingRepository, permissions),
        competitionSchedulingRepository,
      ),
    );
    const competitionStandingsAdapter = new DiscordCompetitionStandingsCommandAdapter(
      new CompetitionStandingsCommandHandler(competitionStandings, competitionStandingsRepository),
    );
    const competitionResultsHistoryRepository = new PostgresCompetitionResultsHistoryRepository(
      connection.database,
    );
    const competitionResultsHistoryAdapter = new DiscordCompetitionResultsHistoryCommandAdapter(
      new CompetitionResultsHistoryCommandHandler(
        new CompetitionResultsHistoryService(competitionResultsHistoryRepository),
      ),
    );
    const competitionChannelConfigurationAdapter =
      new DiscordCompetitionChannelConfigurationCommandAdapter(
        new ConfigureCompetitionChannelService(configurationRepository, permissions),
      );
    const competitionResultDeliveryRecoveryScheduler =
      dependencies.createCompetitionResultDeliveryRecoveryScheduler?.(
        new CompetitionResultDeliveryService(
          new PostgresCompetitionResultDeliveryRepository(connection.database),
          new CompetitionResultsHistoryService(competitionResultsHistoryRepository),
          new DiscordCompetitionResultPublisher(
            client,
            new PostgresCompetitionRoleRepository(connection.database),
          ),
        ),
        logger,
      );
    const competitionRoleRecoveryScheduler = dependencies.createCompetitionRoleRecoveryScheduler?.(
      new CompetitionRoleLifecycleService(
        new PostgresCompetitionRoleRepository(connection.database),
        new DiscordCompetitionRolePublisher(client),
        undefined,
        new CompetitionRoleFailureAuditService(
          audit,
          new DiscordCompetitionRoleFailurePublisher(client),
        ),
      ),
      logger,
    );
    const targetRaceClaimRepository = new PostgresTargetRaceClaimRepository(connection.database);
    const targetRaceClaimService = new TargetRaceClaimService(
      targetRaceClaimRepository,
      permissions,
      hiscores,
      randomUUID,
    );
    const targetRaceDeadlineFinalizationScheduler =
      dependencies.createTargetRaceDeadlineFinalizationScheduler?.(
        new TargetRaceDeadlineFinalizationService(
          new PostgresTargetRaceDeadlineFinalizationRepository(connection.database),
          hiscores,
          undefined,
          new TargetRaceDeadlineFailureAuditService(
            audit,
            new DiscordCompetitionStartFailureAuditPublisher(client, configurationService),
          ),
        ),
        logger,
        targetRaceClaimService,
      );
    const timedCompetitionFinalizationRepository =
      new PostgresTimedCompetitionFinalizationRepository(connection.database);
    const timedCompetitionFinalizationService = new TimedCompetitionFinalizationService(
      timedCompetitionFinalizationRepository,
      hiscores,
      undefined,
      new TimedCompetitionFinalizationFailureAuditService(
        audit,
        new DiscordCompetitionStartFailureAuditPublisher(client, configurationService),
      ),
      audit,
    );
    const competitionManualFinalizationAdapter =
      new DiscordCompetitionManualFinalizationCommandAdapter(
        new CompetitionManualFinalizationCommandHandler(
          timedCompetitionFinalizationService,
          timedCompetitionFinalizationRepository,
          permissions,
        ),
      );
    const timedCompetitionFinalizationScheduler =
      dependencies.createTimedCompetitionFinalizationScheduler?.(
        timedCompetitionFinalizationService,
        logger,
      );
    const targetRaceClaimAdapter = new DiscordCompetitionTargetRaceClaimCommandAdapter(
      new CompetitionTargetRaceClaimCommandHandler(
        targetRaceClaimService,
        targetRaceClaimRepository,
        permissions,
      ),
    );

    interactionDispatcher = new DiscordInteractionDispatcher(client);

    bindDiscordAccountCommandAdapter(
      interactionDispatcher,
      adapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionCancellationCommandAdapter(
      interactionDispatcher,
      competitionCancellationAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionManualFinalizationCommandAdapter(
      interactionDispatcher,
      competitionManualFinalizationAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordSkillLookupCommandAdapter(
      interactionDispatcher,
      skillLookupAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordOneTimeSkillLookupCommandAdapter(
      interactionDispatcher,
      oneTimeSkillLookupAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordOneTimeBossLookupCommandAdapter(
      interactionDispatcher,
      oneTimeBossLookupAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordSkillLeaderboardCommandAdapter(
      interactionDispatcher,
      skillLeaderboardAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordBossLeaderboardCommandAdapter(
      interactionDispatcher,
      bossLeaderboardAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordBossLookupCommandAdapter(
      interactionDispatcher,
      bossLookupAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordDailyRecapPreviewCommandAdapter(
      interactionDispatcher,
      dailyRecapPreviewAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordManualDailyRecapSendCommandAdapter(
      interactionDispatcher,
      manualDailyRecapSendAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordDailyRecapConfigurationCommandAdapter(
      interactionDispatcher,
      dailyRecapConfigurationAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionCreateCommandAdapter(
      interactionDispatcher,
      competitionCreateAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionDraftParticipationCommandAdapter(
      interactionDispatcher,
      competitionDraftParticipationAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionStartCommandAdapter(
      interactionDispatcher,
      competitionStartAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionScheduleCommandAdapter(
      interactionDispatcher,
      competitionScheduleAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionStandingsCommandAdapter(
      interactionDispatcher,
      competitionStandingsAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionResultsHistoryCommandAdapter(
      interactionDispatcher,
      competitionResultsHistoryAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionChannelConfigurationCommandAdapter(
      interactionDispatcher,
      competitionChannelConfigurationAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordCompetitionTargetRaceClaimCommandAdapter(
      interactionDispatcher,
      targetRaceClaimAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordMemberPresenceEventAdapter(
      client,
      memberPresenceAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (member) => member.guild.id === configuration.discord.guildId,
    );
    client.once(Events.ClientReady, () => {
      logger.write({
        operation: 'discord.ready',
        severity: 'info',
        timestamp: new Date().toISOString(),
      });
    });
    client.on(Events.Error, () => {
      logger.write({
        operation: 'discord.client_error',
        severity: 'error',
        timestamp: new Date().toISOString(),
      });
    });

    await client.login(configuration.discord.token);
    await competitionResultDeliveryRecoveryScheduler?.start();
    await competitionRoleRecoveryScheduler?.start();
    await competitionStartDeliveryRecoveryScheduler?.start();
    await deliveryRecoveryScheduler.start();
    await automaticSchedulingScheduler.start();
    await automaticCollectionScheduler.start();
    await competitionStartRetryScheduler.start();
    await targetRaceDeadlineFinalizationScheduler?.start();
    await timedCompetitionFinalizationScheduler?.start();
    return createRuntime(
      client,
      connection,
      logger,
      interactionDispatcher,
      deliveryRecoveryScheduler,
      automaticSchedulingScheduler,
      automaticCollectionScheduler,
      competitionStartRetryScheduler,
      competitionStartDeliveryRecoveryScheduler,
      targetRaceDeadlineFinalizationScheduler,
      timedCompetitionFinalizationScheduler,
      competitionResultDeliveryRecoveryScheduler,
      competitionRoleRecoveryScheduler,
    );
  } catch (error) {
    interactionDispatcher?.stop();
    await client.destroy();
    await connection.close();
    throw error;
  }
}

export async function startDiscordRuntime(
  configuration: RuntimeConfiguration,
  dependencies: DevelopmentDiscordRuntimeDependencies = defaultDependencies,
): Promise<DevelopmentDiscordRuntime> {
  return startDevelopmentDiscordRuntime(configuration, dependencies);
}

export function reportDiscordInteractionFailure(
  logger: StructuredLocalLogger,
  auditContextSanitizer: ReturnType<typeof createRuntimeAuditContextSanitizer>,
  error: unknown,
): void {
  logger.write({
    context: auditContextSanitizer.sanitize({ message: errorMessage(error) }),
    errorReferenceId: createErrorReferenceId(),
    operation: 'discord.interaction_failed',
    severity: 'error',
    timestamp: new Date().toISOString(),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown interaction error occurred.';
}

async function closeRuntime(
  client: Client,
  connection: DatabaseConnection,
  logger: StructuredLocalLogger,
  interactionDispatcher: DiscordInteractionDispatcher,
  deliveryRecoveryScheduler: DailyRecapDeliveryRecoveryScheduler,
  automaticSchedulingScheduler: AutomaticDailyRecapSchedulingScheduler,
  automaticCollectionScheduler: AutomaticDailyRecapCollectionScheduler,
  competitionStartRetryScheduler: CompetitionStartRetryScheduler,
  competitionStartDeliveryRecoveryScheduler: CompetitionStartDeliveryRecoveryScheduler | undefined,
  targetRaceDeadlineFinalizationScheduler:
    InProcessTargetRaceDeadlineFinalizationScheduler | undefined,
  timedCompetitionFinalizationScheduler: InProcessTimedCompetitionFinalizationScheduler | undefined,
  competitionResultDeliveryRecoveryScheduler:
    CompetitionResultDeliveryRecoveryScheduler | undefined,
  competitionRoleRecoveryScheduler: CompetitionRoleRecoveryScheduler | undefined,
): Promise<void> {
  deliveryRecoveryScheduler.stop();
  automaticSchedulingScheduler.stop();
  automaticCollectionScheduler.stop();
  competitionStartRetryScheduler.stop();
  competitionStartDeliveryRecoveryScheduler?.stop();
  targetRaceDeadlineFinalizationScheduler?.stop();
  timedCompetitionFinalizationScheduler?.stop();
  competitionResultDeliveryRecoveryScheduler?.stop();
  competitionRoleRecoveryScheduler?.stop();
  interactionDispatcher.stop();
  await client.destroy();
  await connection.close();
  logger.write({
    operation: 'discord.stopped',
    severity: 'info',
    timestamp: new Date().toISOString(),
  });
}

function createRuntime(
  client: Client,
  connection: DatabaseConnection,
  logger: StructuredLocalLogger,
  interactionDispatcher: DiscordInteractionDispatcher,
  deliveryRecoveryScheduler: DailyRecapDeliveryRecoveryScheduler,
  automaticSchedulingScheduler: AutomaticDailyRecapSchedulingScheduler,
  automaticCollectionScheduler: AutomaticDailyRecapCollectionScheduler,
  competitionStartRetryScheduler: CompetitionStartRetryScheduler,
  competitionStartDeliveryRecoveryScheduler: CompetitionStartDeliveryRecoveryScheduler | undefined,
  targetRaceDeadlineFinalizationScheduler:
    InProcessTargetRaceDeadlineFinalizationScheduler | undefined,
  timedCompetitionFinalizationScheduler: InProcessTimedCompetitionFinalizationScheduler | undefined,
  competitionResultDeliveryRecoveryScheduler:
    CompetitionResultDeliveryRecoveryScheduler | undefined,
  competitionRoleRecoveryScheduler: CompetitionRoleRecoveryScheduler | undefined,
): DevelopmentDiscordRuntime {
  let closePromise: Promise<void> | undefined;
  return {
    close: () => {
      closePromise ??= closeRuntime(
        client,
        connection,
        logger,
        interactionDispatcher,
        deliveryRecoveryScheduler,
        automaticSchedulingScheduler,
        automaticCollectionScheduler,
        competitionStartRetryScheduler,
        competitionStartDeliveryRecoveryScheduler,
        targetRaceDeadlineFinalizationScheduler,
        timedCompetitionFinalizationScheduler,
        competitionResultDeliveryRecoveryScheduler,
        competitionRoleRecoveryScheduler,
      );
      return closePromise;
    },
  };
}
