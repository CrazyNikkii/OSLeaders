import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import type { SkillLookupResult } from '../src/features/lookups/skill-lookup.js';
import {
  DiscordSkillLookupCommandAdapter,
  SkillLookupCommandHandler,
  skillLookupCommandDefinitions,
} from '../src/infrastructure/discord/skill-lookup-command.js';
import { InMemoryDiscordCommandCooldown } from '../src/infrastructure/discord/discord-command-cooldown.js';

describe('Discord skill lookup command', () => {
  it('registers a guild-only command with canonical skill choices and account autocomplete', () => {
    const definition = skillLookupCommandDefinitions[0];

    expect(definition).toMatchObject({
      description: 'Look up an OSRS skill for a tracked account.',
      name: 'skill',
    });
    expect(JSON.stringify(definition)).toContain('"name":"Strength","value":"Strength"');
    expect(JSON.stringify(definition)).toContain('"autocomplete":true');
  });

  it('autocompletes only accounts from the interaction guild', async () => {
    const services = new LookupServices([
      account(),
      account({ guildId: 'guild-two', id: 'elsewhere' }),
    ]);
    const handler = new SkillLookupCommandHandler(services);

    await expect(handler.autocomplete('guild-one', '')).resolves.toEqual([
      { name: 'Rune Scape (ironman)', value: 'account-one' },
    ]);
    await expect(handler.autocomplete(null, '')).resolves.toEqual([]);
  });

  it('uses the caller default when no account option is supplied', async () => {
    const services = new LookupServices([]);
    const handler = new SkillLookupCommandHandler(services);

    await handler.lookup('guild-one', 'member-one', 'Strength', null);

    expect(services.requests).toEqual([
      {
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        skill: 'Strength',
        target: { kind: 'default_account' },
      },
    ]);
  });

  it('presents found skill data publicly in the shared embed style', async () => {
    const services = new LookupServices([]);
    services.result = foundResult();
    const adapter = new DiscordSkillLookupCommandAdapter(new SkillLookupCommandHandler(services));
    const reply = vi.fn(() => Promise.resolve());

    await adapter.handle(chatInteraction(reply) as never);

    const response = JSON.stringify(reply.mock.calls[0]);
    expect(response).toContain('Strength · Rune Scape');
    expect(response).toContain('OSRS Hiscores');
    expect(response).toContain('**Ironman** · <@member-one>');
    expect(response).toContain('"name":"Level","value":"99"');
    expect(response).toContain('"name":"Experience","value":"13,034,431 XP"');
    expect(response).toContain('"name":"Rank","value":"#42"');
    expect(response).toContain('"color":14261046');
  });

  it('keeps expected lookup failures ephemeral', async () => {
    const services = new LookupServices([]);
    services.result = { kind: 'default_account_not_found' };
    const adapter = new DiscordSkillLookupCommandAdapter(new SkillLookupCommandHandler(services));
    const reply = vi.fn(() => Promise.resolve());

    await adapter.handle(chatInteraction(reply) as never);

    expect(reply).toHaveBeenCalledWith({
      content: 'You do not have a default linked account in this server.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('does not call the lookup service again while the member is cooling down', async () => {
    const services = new LookupServices([]);
    const cooldown = new InMemoryDiscordCommandCooldown({
      now: () => new Date('2026-08-20T10:00:00Z'),
    });
    const adapter = new DiscordSkillLookupCommandAdapter(
      new SkillLookupCommandHandler(services),
      cooldown,
    );
    const firstReply = vi.fn(() => Promise.resolve());
    const secondReply = vi.fn(() => Promise.resolve());

    await adapter.handle(chatInteraction(firstReply) as never);
    await adapter.handle(chatInteraction(secondReply) as never);

    expect(services.requests).toHaveLength(1);
    expect(secondReply).toHaveBeenCalledWith({
      content: 'Please wait 3 seconds before another Hiscores command.',
      flags: MessageFlags.Ephemeral,
    });
  });
});

class LookupServices {
  public readonly requests: unknown[] = [];
  public result: SkillLookupResult = foundResult();

  public constructor(private readonly accounts: readonly TrackedAccount[]) {}

  public accountRetrieval = {
    listForGuild: (guildId: string) =>
      Promise.resolve(this.accounts.filter((account) => account.guildId === guildId)),
  };

  public skillLookup = {
    lookup: (request: unknown) => {
      this.requests.push(request);
      return Promise.resolve(this.result);
    },
  };
}

function chatInteraction(reply: ReturnType<typeof vi.fn>) {
  return {
    commandName: 'skill',
    guildId: 'guild-one',
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    options: {
      getString: (name: string) => (name === 'skill' ? 'Strength' : null),
    },
    reply,
    user: { id: 'member-one' },
  };
}

function account(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    accountMode: 'ironman',
    association: { discordUserId: 'member-one', type: 'linked' },
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    displayUsername: 'Rune Scape',
    guildId: 'guild-one',
    id: 'account-one',
    isDefault: true,
    normalizedUsername: 'rune scape',
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
    ...overrides,
  };
}

function foundResult(): Extract<SkillLookupResult, { kind: 'found' }> {
  return {
    kind: 'found',
    skill: { experience: 13_034_431, id: 2, level: 99, name: 'Strength', rank: 42 },
    target: { account: account(), kind: 'tracked_account' },
  };
}
