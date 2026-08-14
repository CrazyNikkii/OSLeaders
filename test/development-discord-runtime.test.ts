import { Events, MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeConfiguration } from '../src/infrastructure/config/runtime-environment.js';
import { createRuntimeAuditContextSanitizer } from '../src/infrastructure/logging/runtime-audit-context-sanitizer.js';
import type {
  StructuredLocalLogger,
  StructuredLogEntry,
} from '../src/shared/structured-logging.js';
import {
  reportDiscordInteractionFailure,
  startDevelopmentDiscordRuntime,
  type DevelopmentDiscordRuntimeDependencies,
} from '../src/infrastructure/discord/development-runtime.js';

describe('development Discord runtime', () => {
  it('checks PostgreSQL before logging in, then closes Discord and PostgreSQL once', async () => {
    const dependencies = new RuntimeDependencies();

    const runtime = await startDevelopmentDiscordRuntime(
      configuration(),
      dependencies.asDependencies(),
    );
    await runtime.close();
    await runtime.close();

    expect(dependencies.pool.query).toHaveBeenCalledWith('SELECT 1');
    expect(dependencies.client.login).toHaveBeenCalledWith('token-one');
    expect(dependencies.client.destroy).toHaveBeenCalledOnce();
    expect(dependencies.closeDatabase).toHaveBeenCalledOnce();
    expect(dependencies.deliveryRecoveryScheduler.start).toHaveBeenCalledOnce();
    expect(dependencies.deliveryRecoveryScheduler.stop).toHaveBeenCalledOnce();
    expect(dependencies.automaticSchedulingScheduler.start).toHaveBeenCalledOnce();
    expect(dependencies.automaticSchedulingScheduler.stop).toHaveBeenCalledOnce();
    expect(dependencies.automaticCollectionScheduler.start).toHaveBeenCalledOnce();
    expect(dependencies.automaticCollectionScheduler.stop).toHaveBeenCalledOnce();
    expect(dependencies.competitionStartRetryScheduler.start).toHaveBeenCalledOnce();
    expect(dependencies.competitionStartRetryScheduler.stop).toHaveBeenCalledOnce();
    expect(dependencies.competitionStartDeliveryRecoveryScheduler.start).toHaveBeenCalledOnce();
    expect(dependencies.competitionStartDeliveryRecoveryScheduler.stop).toHaveBeenCalledOnce();
    expect(dependencies.createTargetRaceDeadlineFinalizationScheduler).toHaveBeenCalledOnce();
    expect(dependencies.targetRaceDeadlineFinalizationScheduler.start).toHaveBeenCalledOnce();
    expect(dependencies.targetRaceDeadlineFinalizationScheduler.stop).toHaveBeenCalledOnce();
    expect(dependencies.createTimedCompetitionFinalizationScheduler).toHaveBeenCalledOnce();
    expect(dependencies.timedCompetitionFinalizationScheduler.start).toHaveBeenCalledOnce();
    expect(dependencies.timedCompetitionFinalizationScheduler.stop).toHaveBeenCalledOnce();
  });

  it('starts the production runtime using its separately selected guild', async () => {
    const dependencies = new RuntimeDependencies();

    const runtime = await startDevelopmentDiscordRuntime(
      configuration({
        discord: { ...configuration().discord, guildId: 'production-guild-one' },
        environment: 'production',
      }),
      dependencies.asDependencies(),
    );

    expect(dependencies.client.login).toHaveBeenCalledWith('token-one');
    await runtime.close();
  });

  it('closes allocated resources when PostgreSQL validation fails', async () => {
    const dependencies = new RuntimeDependencies();
    dependencies.pool.query.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      startDevelopmentDiscordRuntime(configuration(), dependencies.asDependencies()),
    ).rejects.toThrow('database unavailable');
    expect(dependencies.client.login).not.toHaveBeenCalled();
    expect(dependencies.client.destroy).toHaveBeenCalledOnce();
    expect(dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it('closes allocated resources when Discord login fails', async () => {
    const dependencies = new RuntimeDependencies();
    dependencies.client.login.mockRejectedValueOnce(new Error('Discord login failed'));

    await expect(
      startDevelopmentDiscordRuntime(configuration(), dependencies.asDependencies()),
    ).rejects.toThrow('Discord login failed');
    expect(dependencies.pool.query).toHaveBeenCalledWith('SELECT 1');
    expect(dependencies.client.destroy).toHaveBeenCalledOnce();
    expect(dependencies.closeDatabase).toHaveBeenCalledOnce();
    expect(dependencies.interactionHandlers).toHaveLength(0);
    expect(dependencies.client.off).toHaveBeenCalledOnce();
  });

  it('binds the skill lookup adapter to development-guild interactions', async () => {
    const dependencies = new RuntimeDependencies();
    const runtime = await startDevelopmentDiscordRuntime(
      configuration(),
      dependencies.asDependencies(),
    );
    const reply = vi.fn(() => Promise.resolve());

    for (const handler of dependencies.interactionHandlers) {
      handler({
        commandName: 'skill',
        guildId: 'development-guild-one',
        isAutocomplete: () => false,
        isButton: () => false,
        isChatInputCommand: () => true,
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        options: { getString: (name: string) => (name === 'skill' ? 'Strength' : null) },
        reply,
        user: { id: 'member-one' },
      } as never);
    }
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());

    expect(dependencies.interactionHandlers).toHaveLength(1);
    expect(dependencies.memberPresenceHandlers).toHaveLength(2);
    expect(reply).toHaveBeenCalledWith({
      content: 'You do not have a default linked account in this server.',
      flags: MessageFlags.Ephemeral,
    });
    expect(dependencies.logger.entries).toEqual([]);
    await runtime.close();
  });

  it('installs one interaction listener and removes it before a runtime restart', async () => {
    const dependencies = new RuntimeDependencies();

    const firstRuntime = await startDevelopmentDiscordRuntime(
      configuration(),
      dependencies.asDependencies(),
    );
    expect(dependencies.interactionHandlers).toHaveLength(1);

    await firstRuntime.close();
    expect(dependencies.interactionHandlers).toHaveLength(0);

    const restartedRuntime = await startDevelopmentDiscordRuntime(
      configuration(),
      dependencies.asDependencies(),
    );
    expect(dependencies.interactionHandlers).toHaveLength(1);

    await restartedRuntime.close();
    expect(dependencies.client.off).toHaveBeenCalledTimes(2);
  });

  it('records a sanitized diagnostic message and reference for interaction failures', () => {
    const dependencies = new RuntimeDependencies();
    const configurationValue = configuration({
      database: {
        connectionString: 'postgresql://owner:database-password@localhost:5432/osleaders_dev',
        poolMax: 4,
      },
      discord: { ...configuration().discord, token: 'discord-token-secret' },
    });

    reportDiscordInteractionFailure(
      dependencies.logger,
      createRuntimeAuditContextSanitizer(configurationValue),
      new Error(
        'Database postgresql://owner:database-password@localhost:5432/osleaders_dev rejected discord-token-secret.',
      ),
    );

    expect(dependencies.logger.entries).toHaveLength(1);
    expect(dependencies.logger.entries[0]).toMatchObject({
      context: { message: 'Database [REDACTED] rejected [REDACTED].' },
      operation: 'discord.interaction_failed',
    });
    expect(dependencies.logger.entries[0]?.errorReferenceId).toMatch(/^err_[a-f0-9]{12}$/);
  });
});

class RuntimeDependencies {
  public readonly closeDatabase = vi.fn(() => Promise.resolve());
  public readonly database = {
    select: () => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }),
  };
  public readonly interactionHandlers: ((interaction: never) => void)[] = [];
  public readonly memberPresenceHandlers: ((member: never) => void)[] = [];
  public readonly client = {
    destroy: vi.fn(),
    login: vi.fn(() => Promise.resolve('token-one')),
    on: vi.fn((event: Events, listener: (interaction: never) => void) => {
      if (event === Events.InteractionCreate) {
        this.interactionHandlers.push(listener);
      }
      if (event === Events.GuildMemberAdd || event === Events.GuildMemberRemove) {
        this.memberPresenceHandlers.push(listener);
      }
    }),
    off: vi.fn((event: Events, listener: (interaction: never) => void) => {
      if (event === Events.InteractionCreate) {
        const index = this.interactionHandlers.indexOf(listener);
        if (index >= 0) this.interactionHandlers.splice(index, 1);
      }
    }),
    once: vi.fn(),
  };
  public readonly createClient = vi.fn(() => this.client as never);
  public readonly createDatabaseConnection = vi.fn(() => ({
    close: this.closeDatabase,
    database: this.database,
    pool: this.pool,
  }));
  public readonly deliveryRecoveryScheduler = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  };
  public readonly automaticSchedulingScheduler = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  };
  public readonly automaticCollectionScheduler = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  };
  public readonly competitionStartRetryScheduler = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  };
  public readonly competitionStartDeliveryRecoveryScheduler = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  };
  public readonly targetRaceDeadlineFinalizationScheduler = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  };
  public readonly createTargetRaceDeadlineFinalizationScheduler = vi.fn(
    () => this.targetRaceDeadlineFinalizationScheduler,
  );
  public readonly timedCompetitionFinalizationScheduler = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  };
  public readonly createTimedCompetitionFinalizationScheduler = vi.fn(
    () => this.timedCompetitionFinalizationScheduler,
  );
  public readonly logger = new RecordingLogger();
  public readonly pool = { query: vi.fn(() => Promise.resolve()) };

  public asDependencies(): DevelopmentDiscordRuntimeDependencies {
    return {
      createClient: this.createClient,
      createDatabaseConnection: this.createDatabaseConnection as never,
      createDailyRecapDeliveryRecoveryScheduler: vi.fn(() => this.deliveryRecoveryScheduler),
      createAutomaticDailyRecapSchedulingScheduler: vi.fn(() => this.automaticSchedulingScheduler),
      createAutomaticDailyRecapCollectionScheduler: vi.fn(() => this.automaticCollectionScheduler),
      createCompetitionStartRetryScheduler: vi.fn(() => this.competitionStartRetryScheduler),
      createCompetitionStartDeliveryRecoveryScheduler: vi.fn(
        () => this.competitionStartDeliveryRecoveryScheduler,
      ),
      createTargetRaceDeadlineFinalizationScheduler: this
        .createTargetRaceDeadlineFinalizationScheduler as never,
      createTimedCompetitionFinalizationScheduler: this
        .createTimedCompetitionFinalizationScheduler as never,
      createLogger: () => this.logger,
    };
  }
}

class RecordingLogger implements StructuredLocalLogger {
  public readonly entries: StructuredLogEntry[] = [];

  public write(entry: StructuredLogEntry): void {
    this.entries.push(entry);
  }
}

function configuration(overrides: Partial<RuntimeConfiguration> = {}): RuntimeConfiguration {
  return {
    database: { connectionString: 'postgresql://localhost/osleaders_dev', poolMax: 4 },
    discord: {
      applicationId: 'application-one',
      guildId: 'development-guild-one',
      token: 'token-one',
    },
    environment: 'development',
    logLevel: 'info',
    ...overrides,
  };
}
