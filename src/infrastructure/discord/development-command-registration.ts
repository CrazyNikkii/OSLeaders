import { REST, Routes } from 'discord.js';

import type { RuntimeConfiguration } from '../config/runtime-environment.js';
import { accountCommandDefinitions } from './account-command-foundation.js';
import { skillLookupCommandDefinitions } from './skill-lookup-command.js';
import { oneTimeSkillLookupCommandDefinitions } from './one-time-skill-lookup-command.js';
import { oneTimeBossLookupCommandDefinitions } from './one-time-boss-lookup-command.js';
import { skillLeaderboardCommandDefinitions } from './skill-leaderboard-command.js';
import { bossLeaderboardCommandDefinitions } from './boss-leaderboard-command.js';
import { bossLookupCommandDefinitions } from './boss-lookup-command.js';
import { dailyRecapPreviewCommandDefinitions } from './daily-recap-preview-command.js';
import { competitionCommandDefinitions } from './competition-create-command.js';

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

export async function registerDiscordCommands(
  configuration: RuntimeConfiguration,
  registrar: DevelopmentCommandRegistrar = new DiscordDevelopmentCommandRegistrar(
    new REST({ version: '10' }).setToken(configuration.discord.token),
  ),
): Promise<void> {
  await registrar.put(configuration.discord.applicationId, configuration.discord.guildId, [
    ...accountCommandDefinitions,
    ...skillLookupCommandDefinitions,
    ...oneTimeSkillLookupCommandDefinitions,
    ...oneTimeBossLookupCommandDefinitions,
    ...skillLeaderboardCommandDefinitions,
    ...bossLeaderboardCommandDefinitions,
    ...bossLookupCommandDefinitions,
    ...dailyRecapPreviewCommandDefinitions,
    ...competitionCommandDefinitions,
  ]);
}
