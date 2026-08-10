import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import type { BossLookupResult } from '../src/features/lookups/boss-lookup.js';
import { OSRS_BOSS_ACTIVITY_NAMES } from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';
import {
  BossLookupCommandHandler,
  DiscordBossLookupCommandAdapter,
  bossLookupCommandDefinitions,
} from '../src/infrastructure/discord/boss-lookup-command.js';
import {
  bossChoiceGroups,
  bossChoiceGroupLabel,
  raidChoiceGroup,
} from '../src/infrastructure/discord/boss-choice-menu.js';

describe('Discord boss lookup command', () => {
  it('registers a guild-only command with account autocomplete and menu-driven boss selection', () => {
    const definition = bossLookupCommandDefinitions[0];

    expect(definition).toMatchObject({
      description: 'Look up an OSRS boss kill count for a tracked account.',
      name: 'boss',
    });
    const options = definition.options ?? [];
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ name: 'account' });
  });

  it('autocompletes only accounts from the interaction guild', async () => {
    const services = new LookupServices([
      account(),
      account({ guildId: 'guild-two', id: 'elsewhere' }),
    ]);
    const handler = new BossLookupCommandHandler(services);

    await expect(handler.autocomplete('guild-one', 'account', '')).resolves.toEqual([
      { name: 'Rune Scape (ironman)', value: 'account-one' },
    ]);
    await expect(handler.autocomplete(null, 'account', '')).resolves.toEqual([]);
  });

  it('separates raids from bounded alphabetical boss menus and sorts The Gauntlet under G', () => {
    const choices = bossChoiceGroups.flatMap((group) => group.map((choice) => choice.value));
    const raids = raidChoiceGroup.map((choice) => choice.value);
    const gauntletGroup = bossChoiceGroups.findIndex((group) =>
      group.some((choice) => choice.value === 'The Gauntlet'),
    );

    expect([...choices, ...raids]).toEqual(expect.arrayContaining([...OSRS_BOSS_ACTIVITY_NAMES]));
    expect(choices).toContain('Mad Angel');
    expect(raids).toEqual([
      'Chambers of Xeric',
      'Chambers of Xeric: Challenge Mode',
      'Theatre of Blood',
      'Theatre of Blood: Hard Mode',
      'Tombs of Amascut',
      'Tombs of Amascut: Expert Mode',
    ]);
    expect(choices).not.toEqual(expect.arrayContaining(raids));
    expect([...choices, ...raids]).toHaveLength(OSRS_BOSS_ACTIVITY_NAMES.length);
    expect(new Set([...choices, ...raids])).toHaveLength(OSRS_BOSS_ACTIVITY_NAMES.length);
    expect(bossChoiceGroups.every((group) => group.length <= 25)).toBe(true);
    expect(raidChoiceGroup.length).toBeLessThanOrEqual(25);
    expect(bossChoiceGroupLabel(bossChoiceGroups[gauntletGroup] ?? [])).toContain('G');
    expect(choices.indexOf('The Gauntlet')).toBeLessThan(choices.indexOf('Giant Mole'));
  });

  it('keeps the lookup guild-scoped and public only after a boss menu selection', async () => {
    const services = new LookupServices([]);
    const adapter = new DiscordBossLookupCommandAdapter(new BossLookupCommandHandler(services));
    const command = commandInteraction();

    await adapter.handle(command as never);

    expect(command.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Choose the boss to look up.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    const response = command.reply.mock.calls[0]?.[0];
    if (response === undefined) throw new Error('Expected boss menu response.');
    const row = response.components.find((candidate) =>
      candidate
        .toJSON()
        .components[0]?.options.some((option) => option.value === 'Tombs of Amascut'),
    );
    const customId = row?.toJSON().components[0]?.custom_id;
    if (customId === undefined) throw new Error('Expected raid selector.');

    const selection = selectInteraction(customId, 'Tombs of Amascut');
    await adapter.handle(selection as never);

    expect(services.requests).toEqual([
      {
        boss: 'Tombs of Amascut',
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        target: { kind: 'default_account' },
      },
    ]);
    expect(selection.deferUpdate).toHaveBeenCalledOnce();
    expect(selection.channel.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(selection.channel.send.mock.calls[0])).toContain(
      'Abyssal Sire · Rune Scape',
    );
    expect(JSON.stringify(selection.channel.send.mock.calls[0])).toContain(
      '**Ironman** · <@member-one>',
    );
    expect(JSON.stringify(selection.channel.send.mock.calls[0])).toContain('OSRS Hiscores');
    expect(selection.deleteReply).toHaveBeenCalledOnce();
    expect(selection.editReply).not.toHaveBeenCalled();
  });

  it('keeps expected lookup failures private after a selection', async () => {
    const services = new LookupServices([]);
    services.result = { kind: 'default_account_not_found' };
    const adapter = new DiscordBossLookupCommandAdapter(new BossLookupCommandHandler(services));
    const command = commandInteraction();
    await adapter.handle(command as never);
    const response = command.reply.mock.calls[0]?.[0];
    if (response === undefined) throw new Error('Expected boss menu response.');
    const customId = response.components[0]?.toJSON().components[0]?.custom_id;
    if (customId === undefined) throw new Error('Expected boss selector.');

    const selection = selectInteraction(customId, 'Abyssal Sire');
    await adapter.handle(selection as never);

    expect(selection.editReply).toHaveBeenCalledWith({
      components: [],
      content: 'You do not have a default linked account in this server.',
    });
  });

  it('binds selections to their guild and requester and expires them after five minutes', async () => {
    const services = new LookupServices([]);
    const clock = new FakeClock();
    const handler = new BossLookupCommandHandler(services, clock);
    const started = handler.start('guild-one', 'member-one', null);
    if (started.kind !== 'boss_selection') throw new Error('Expected boss selection.');
    const customId = started.customIds[0];
    if (customId === undefined) throw new Error('Expected boss selector.');

    await expect(
      handler.selectBoss('guild-one', 'member-two', customId, 'Abyssal Sire'),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      handler.selectBoss('guild-two', 'member-one', customId, 'Abyssal Sire'),
    ).resolves.toEqual({ kind: 'forbidden' });

    const expiring = handler.start('guild-one', 'member-one', null);
    if (expiring.kind !== 'boss_selection') throw new Error('Expected boss selection.');
    const expiringCustomId = expiring.customIds[0];
    if (expiringCustomId === undefined) throw new Error('Expected boss selector.');
    clock.advance(5 * 60 * 1_000);

    await expect(
      handler.selectBoss('guild-one', 'member-one', expiringCustomId, 'Abyssal Sire'),
    ).resolves.toEqual({ kind: 'expired' });
    expect(services.requests).toEqual([]);
  });
});

class LookupServices {
  public readonly requests: unknown[] = [];
  public result: BossLookupResult = foundResult();

  public constructor(private readonly accounts: readonly TrackedAccount[]) {}

  public accountRetrieval = {
    listForGuild: (guildId: string) =>
      Promise.resolve(this.accounts.filter((account) => account.guildId === guildId)),
  };

  public bossLookup = {
    lookup: (request: unknown) => {
      this.requests.push(request);
      return Promise.resolve(this.result);
    },
  };
}

class FakeClock {
  private current = new Date('2026-08-05T00:00:00.000Z');

  public now(): Date {
    return this.current;
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function commandInteraction() {
  return {
    commandName: 'boss',
    guildId: 'guild-one',
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    options: { getString: () => null },
    reply: vi.fn<(result: MenuResponse) => Promise<void>>(() => Promise.resolve()),
    user: { id: 'member-one' },
  };
}

function selectInteraction(customId: string, value: string) {
  return {
    channel: { isSendable: () => true, send: vi.fn(() => Promise.resolve()) },
    customId,
    deferUpdate: vi.fn(() => Promise.resolve()),
    deleteReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    guildId: 'guild-one',
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => true,
    user: { id: 'member-one' },
    values: [value],
  };
}

interface MenuResponse {
  components: { toJSON(): { components: { custom_id: string; options: { value: string }[] }[] } }[];
  content: string;
  flags: MessageFlags;
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
