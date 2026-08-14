import { Events, type Client, type Interaction } from 'discord.js';

export interface DiscordInteractionRegistrar {
  on(event: Events.InteractionCreate, listener: (interaction: Interaction) => void): void;
}

/**
 * Installs one Discord listener and fans eligible interactions out to the
 * command adapters registered during runtime composition.
 */
export class DiscordInteractionDispatcher implements DiscordInteractionRegistrar {
  private readonly listeners: ((interaction: Interaction) => void)[] = [];
  private stopped = false;

  private readonly handleInteraction = (interaction: Interaction): void => {
    if (this.stopped) return;

    for (const listener of this.listeners) {
      listener(interaction);
    }
  };

  public constructor(private readonly client: Pick<Client, 'on' | 'off'>) {
    client.on(Events.InteractionCreate, this.handleInteraction);
  }

  public on(_event: Events.InteractionCreate, listener: (interaction: Interaction) => void): void {
    if (this.stopped) return;
    this.listeners.push(listener);
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.listeners.length = 0;
    this.client.off(Events.InteractionCreate, this.handleInteraction);
  }
}
