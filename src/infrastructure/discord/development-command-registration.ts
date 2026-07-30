import { REST, Routes } from 'discord.js';

import type { RuntimeConfiguration } from '../config/runtime-environment.js';
import { accountCommandDefinitions } from './account-command-foundation.js';
import { skillLookupCommandDefinitions } from './skill-lookup-command.js';

export interface DevelopmentCommandRegistrar {
  put(applicationId: string, guildId: string, commands: readonly object[]): Promise<void>;
}

export class DiscordDevelopmentCommandRegistrar implements DevelopmentCommandRegistrar {
  public constructor(private readonly rest: REST) {}

  public async put(
    applicationId: string,
    guildId: string,
    commands: readonly object[],
  ): Promise<void> {
    await this.rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
      body: commands,
    });
  }
}

export async function registerDevelopmentDiscordCommands(
  configuration: RuntimeConfiguration,
  registrar: DevelopmentCommandRegistrar = new DiscordDevelopmentCommandRegistrar(
    new REST({ version: '10' }).setToken(configuration.discord.token),
  ),
): Promise<void> {
  if (configuration.environment !== 'development') {
    throw new Error('Development Discord command registration requires NODE_ENV=development.');
  }
  if (configuration.discord.developmentGuildId === undefined) {
    throw new Error('DISCORD_DEVELOPMENT_GUILD_ID must be configured for development commands.');
  }

  await registrar.put(
    configuration.discord.applicationId,
    configuration.discord.developmentGuildId,
    [...accountCommandDefinitions, ...skillLookupCommandDefinitions],
  );
}
