import type { Client } from 'discord.js';

import type { CompetitionRoleFailurePublisher } from '../../features/competitions/report-competition-role-failures.js';

export class DiscordCompetitionRoleFailurePublisher implements CompetitionRoleFailurePublisher {
  public constructor(private readonly client: Pick<Client, 'users'>) {}

  public async warnCreator(request: {
    content: string;
    creatorDiscordUserId: string;
    guildId: string;
  }): Promise<void> {
    const creator = await this.client.users.fetch(request.creatorDiscordUserId);
    await creator.send({ content: request.content });
  }
}
