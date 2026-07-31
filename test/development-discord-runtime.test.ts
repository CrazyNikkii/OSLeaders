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
  });

  it('does not construct external dependencies outside development', async () => {
    const dependencies = new RuntimeDependencies();

    await expect(
      startDevelopmentDiscordRuntime(
        configuration({ environment: 'production' }),
        dependencies.asDependencies(),
      ),
    ).rejects.toThrow('NODE_ENV=development');
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(dependencies.createDatabaseConnection).not.toHaveBeenCalled();
  });

  it('requires a configured development guild before constructing external dependencies', async () => {
    const dependencies = new RuntimeDependencies();

    await expect(
      startDevelopmentDiscordRuntime(
        configuration({ discord: { ...configuration().discord, developmentGuildId: undefined } }),
        dependencies.asDependencies(),
      ),
    ).rejects.toThrow('DISCORD_DEVELOPMENT_GUILD_ID must be configured');
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(dependencies.createDatabaseConnection).not.toHaveBeenCalled();
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

    expect(dependencies.interactionHandlers).toHaveLength(9);
    expect(reply).toHaveBeenCalledWith({
      content: 'You do not have a default linked account in this server.',
      flags: MessageFlags.Ephemeral,
    });
    expect(dependencies.logger.entries).toEqual([]);
    await runtime.close();
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
  public readonly client = {
    destroy: vi.fn(),
    login: vi.fn(() => Promise.resolve('token-one')),
    on: vi.fn((event: Events, listener: (interaction: never) => void) => {
      if (event === Events.InteractionCreate) {
        this.interactionHandlers.push(listener);
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
  public readonly logger = new RecordingLogger();
  public readonly pool = { query: vi.fn(() => Promise.resolve()) };

  public asDependencies(): DevelopmentDiscordRuntimeDependencies {
    return {
      createClient: this.createClient,
      createDatabaseConnection: this.createDatabaseConnection as never,
      createDailyRecapDeliveryRecoveryScheduler: vi.fn(() => this.deliveryRecoveryScheduler),
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
      developmentGuildId: 'development-guild-one',
      token: 'token-one',
    },
    environment: 'development',
    logLevel: 'info',
    ...overrides,
  };
}
