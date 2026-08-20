const DEFAULT_COOLDOWN_MS = 3_000;

export interface DiscordCommandCooldownClock {
  now(): Date;
}

export interface DiscordCommandCooldownRequest {
  guildId: string;
  requesterDiscordUserId: string;
}

export type DiscordCommandCooldownResult =
  { kind: 'granted' } | { kind: 'cooling_down'; retryAfterSeconds: number };

/**
 * Bounds expensive Discord command starts without introducing durable state or
 * a separate runtime component. The configured runtime shares one instance
 * across all Hiscores-backed command adapters.
 */
export class InMemoryDiscordCommandCooldown {
  private readonly nextAllowedAtByMember = new Map<string, number>();

  public constructor(
    private readonly clock: DiscordCommandCooldownClock = { now: () => new Date() },
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
  ) {
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1) {
      throw new Error('Discord command cooldown must be a positive safe integer.');
    }
  }

  public tryAcquire(request: DiscordCommandCooldownRequest): DiscordCommandCooldownResult {
    const now = this.clock.now().getTime();
    this.pruneExpired(now);
    const key = `${request.guildId}:${request.requesterDiscordUserId}`;
    const nextAllowedAt = this.nextAllowedAtByMember.get(key);
    if (nextAllowedAt !== undefined && nextAllowedAt > now) {
      return {
        kind: 'cooling_down',
        retryAfterSeconds: Math.ceil((nextAllowedAt - now) / 1_000),
      };
    }

    this.nextAllowedAtByMember.set(key, now + this.cooldownMs);
    return { kind: 'granted' };
  }

  private pruneExpired(now: number): void {
    for (const [key, nextAllowedAt] of this.nextAllowedAtByMember) {
      if (nextAllowedAt <= now) this.nextAllowedAtByMember.delete(key);
    }
  }
}

export function discordCommandCooldownMessage(retryAfterSeconds: number): string {
  return `Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'} before another Hiscores command.`;
}
