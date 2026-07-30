import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import type { BossLookupResult } from '../src/features/lookups/boss-lookup.js';
import {
  BossLookupCommandHandler,
  DiscordBossLookupCommandAdapter,
  bossLookupCommandDefinitions,
} from '../src/infrastructure/discord/boss-lookup-command.js';

describe('Discord boss lookup command', () => {
  it('registers a guild-only command with boss and account autocomplete', () => {
    const definition = bossLookupCommandDefinitions[0];

    expect(definition).toMatchObject({
      description: 'Look up an OSRS boss kill count for a tracked account.',
      name: 'boss',
    });
    expect(JSON.stringify(definition)).toContain('"autocomplete":true');
  });

  it('autocompletes canonical bosses and only accounts from the interaction guild', async () => {
    const services = new LookupServices([
      account(),
      account({ guildId: 'guild-two', id: 'elsewhere' }),
    ]);
    const handler = new BossLookupCommandHandler(services);

    await expect(handler.autocomplete('guild-one', 'boss', 'sire')).resolves.toEqual([
      { name: 'Abyssal Sire', value: 'Abyssal Sire' },
    ]);
    await expect(handler.autocomplete('guild-one', 'account', '')).resolves.toEqual([
      { name: 'Rune Scape (ironman)', value: 'account-one' },
    ]);
    await expect(handler.autocomplete(null, 'account', '')).resolves.toEqual([]);
  });

  it('uses the caller default when no account option is supplied', async () => {
    const services = new LookupServices([]);
    const handler = new BossLookupCommandHandler(services);

    await handler.lookup('guild-one', 'member-one', 'Abyssal Sire', null);

    expect(services.requests).toEqual([
      {
        boss: 'Abyssal Sire',
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        target: { kind: 'default_account' },
      },
    ]);
  });

  it('presents found boss data publicly with the account mode label', async () => {
    const services = new LookupServices([]);
    const adapter = new DiscordBossLookupCommandAdapter(new BossLookupCommandHandler(services));
    const interaction = chatInteraction();

    await adapter.handle(interaction as never);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledOnce();
    const response = JSON.stringify(interaction.channel.send.mock.calls[0]);
    expect(response).toContain('Abyssal Sire: Rune Scape');
    expect(response).toContain('"name":"Kill count","value":"13"');
    expect(response).toContain('"name":"Rank","value":"42"');
    expect(response).toContain('"name":"Mode","value":"Ironman"');
  });

  it('keeps expected lookup failures ephemeral', async () => {
    const services = new LookupServices([]);
    services.result = { kind: 'default_account_not_found' };
    const adapter = new DiscordBossLookupCommandAdapter(new BossLookupCommandHandler(services));
    const interaction = chatInteraction();

    await adapter.handle(interaction as never);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'You do not have a default linked account in this server.',
    });
  });

  it('acknowledges before a slow lookup completes, then posts a found result publicly', async () => {
    const services = new LookupServices([]);
    let resolveLookup: (result: BossLookupResult) => void = () => undefined;
    services.lookupResult = new Promise((resolve) => {
      resolveLookup = resolve;
    });
    const adapter = new DiscordBossLookupCommandAdapter(new BossLookupCommandHandler(services));
    const interaction = chatInteraction();

    const handling = adapter.handle(interaction as never);
    await vi.waitFor(() => expect(interaction.deferReply).toHaveBeenCalledOnce());
    expect(interaction.channel.send).not.toHaveBeenCalled();

    resolveLookup(foundResult());
    await handling;

    expect(interaction.channel.send).toHaveBeenCalledOnce();
    expect(interaction.deleteReply).toHaveBeenCalledOnce();
  });

  it('does not confirm public delivery when posting the found result fails', async () => {
    const services = new LookupServices([]);
    const adapter = new DiscordBossLookupCommandAdapter(new BossLookupCommandHandler(services));
    const interaction = chatInteraction();
    interaction.channel.send.mockRejectedValueOnce(new Error('missing send permission'));

    await expect(adapter.handle(interaction as never)).rejects.toThrow('missing send permission');

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'I could not publish that result publicly. Please try again.',
    });
  });
});

class LookupServices {
  public readonly requests: unknown[] = [];
  public lookupResult: Promise<BossLookupResult> | undefined;
  public result: BossLookupResult = foundResult();

  public constructor(private readonly accounts: readonly TrackedAccount[]) {}

  public accountRetrieval = {
    listForGuild: (guildId: string) =>
      Promise.resolve(this.accounts.filter((account) => account.guildId === guildId)),
  };

  public bossLookup = {
    lookup: (request: unknown) => {
      this.requests.push(request);
      return this.lookupResult ?? Promise.resolve(this.result);
    },
  };
}

function chatInteraction() {
  return {
    commandName: 'boss',
    guildId: 'guild-one',
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    options: {
      getString: (name: string) => (name === 'boss' ? 'Abyssal Sire' : null),
    },
    deferReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    deleteReply: vi.fn(() => Promise.resolve()),
    channel: {
      isSendable: () => true,
      send: vi.fn(() => Promise.resolve()),
    },
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

function foundResult(): Extract<BossLookupResult, { kind: 'found' }> {
  return {
    boss: { id: 25, name: 'Abyssal Sire', rank: 42, score: 13 },
    kind: 'found',
    target: { account: account(), kind: 'tracked_account' },
  };
}
