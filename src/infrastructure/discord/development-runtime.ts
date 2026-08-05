import { Client, Events, GatewayIntentBits } from 'discord.js';

import { AccountModeValidator } from '../../features/accounts/validate-account-mode.js';
import { AuditService } from '../../features/audit/audit-service.js';
import { SkillLookupService } from '../../features/lookups/skill-lookup.js';
import { SkillLeaderboardService } from '../../features/leaderboards/skill-leaderboard.js';
import { BossLeaderboardService } from '../../features/leaderboards/boss-leaderboard.js';
import { BossLookupService } from '../../features/lookups/boss-lookup.js';
import { DailyRecapCollectionService } from '../../features/recaps/daily-recap-collection.js';
import { DailyRecapPreviewService } from '../../features/recaps/daily-recap-presentation.js';
import { PreviewDailyRecapService } from '../../features/recaps/preview-daily-recap.js';
import { ManualDailyRecapSendService } from '../../features/recaps/send-daily-recap.js';
import { DailyRecapDeliveryService } from '../../features/recaps/deliver-daily-recap.js';
import { ConfigureDailyRecapService } from '../../features/recaps/configure-daily-recap.js';
import { AutomaticDailyRecapSchedulingService } from '../../features/recaps/schedule-automatic-daily-recaps.js';
import { AutomaticDailyRecapCollectionService } from '../../features/recaps/collect-automatic-daily-recap.js';
import { DailyRecapFailureAuditService } from '../../features/recaps/report-daily-recap-failures.js';
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
import { OsrsHiscoreHttpClient } from '../hiscores/osrs-hiscore-http-client.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../hiscores/osrs-hiscore-catalog.js';
import { StdoutStructuredLocalLogger } from '../logging/structured-local-logger.js';
import { createRuntimeAuditContextSanitizer } from '../logging/runtime-audit-context-sanitizer.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';
import {
  bindDiscordAccountCommandAdapter,
  createAccountDefaultSelectionCommandHandler,
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
}

const defaultDependencies: DevelopmentDiscordRuntimeDependencies = {
  createClient: () => new Client({ intents: [GatewayIntentBits.Guilds] }),
  createDatabaseConnection,
  createLogger: () => new StdoutStructuredLocalLogger(),
  createDailyRecapDeliveryRecoveryScheduler: (delivery, logger) =>
    new InProcessDailyRecapDeliveryRecoveryScheduler(delivery, logger),
  createAutomaticDailyRecapSchedulingScheduler: (schedules, logger) =>
    new InProcessAutomaticDailyRecapSchedulingScheduler(schedules, logger),
  createAutomaticDailyRecapCollectionScheduler: (collection, logger) =>
    new InProcessAutomaticDailyRecapCollectionScheduler(collection, logger),
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

  try {
    await connection.pool.query('SELECT 1');

    const accountRepository = new PostgresAccountRegistrationRepository(connection.database);
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
    const dailyRecapPreviewAdapter = new DiscordDailyRecapPreviewCommandAdapter(
      new PreviewDailyRecapService(
        new DailyRecapPreviewService(
          new DailyRecapCollectionService(
            new PostgresDailyRecapCollectionRepository(connection.database),
            hiscores,
          ),
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
      ),
      logger,
    );
    const dailyRecapConfigurationAdapter = new DiscordDailyRecapConfigurationCommandAdapter(
      new ConfigureDailyRecapService(configurationRepository, permissions),
    );

    bindDiscordAccountCommandAdapter(
      client,
      adapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordSkillLookupCommandAdapter(
      client,
      skillLookupAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordOneTimeSkillLookupCommandAdapter(
      client,
      oneTimeSkillLookupAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordOneTimeBossLookupCommandAdapter(
      client,
      oneTimeBossLookupAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordSkillLeaderboardCommandAdapter(
      client,
      skillLeaderboardAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordBossLeaderboardCommandAdapter(
      client,
      bossLeaderboardAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordBossLookupCommandAdapter(
      client,
      bossLookupAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordDailyRecapPreviewCommandAdapter(
      client,
      dailyRecapPreviewAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordManualDailyRecapSendCommandAdapter(
      client,
      manualDailyRecapSendAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
    );
    bindDiscordDailyRecapConfigurationCommandAdapter(
      client,
      dailyRecapConfigurationAdapter,
      (error) => reportDiscordInteractionFailure(logger, auditContextSanitizer, error),
      (interaction) => interaction.guildId === configuration.discord.guildId,
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
    await deliveryRecoveryScheduler.start();
    await automaticSchedulingScheduler.start();
    await automaticCollectionScheduler.start();
    return createRuntime(
      client,
      connection,
      logger,
      deliveryRecoveryScheduler,
      automaticSchedulingScheduler,
      automaticCollectionScheduler,
    );
  } catch (error) {
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
  deliveryRecoveryScheduler: DailyRecapDeliveryRecoveryScheduler,
  automaticSchedulingScheduler: AutomaticDailyRecapSchedulingScheduler,
  automaticCollectionScheduler: AutomaticDailyRecapCollectionScheduler,
): Promise<void> {
  deliveryRecoveryScheduler.stop();
  automaticSchedulingScheduler.stop();
  automaticCollectionScheduler.stop();
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
  deliveryRecoveryScheduler: DailyRecapDeliveryRecoveryScheduler,
  automaticSchedulingScheduler: AutomaticDailyRecapSchedulingScheduler,
  automaticCollectionScheduler: AutomaticDailyRecapCollectionScheduler,
): DevelopmentDiscordRuntime {
  let closePromise: Promise<void> | undefined;
  return {
    close: () => {
      closePromise ??= closeRuntime(
        client,
        connection,
        logger,
        deliveryRecoveryScheduler,
        automaticSchedulingScheduler,
        automaticCollectionScheduler,
      );
      return closePromise;
    },
  };
}
