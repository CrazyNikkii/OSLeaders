import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { BossLookupResult } from '../src/features/lookups/boss-lookup.js';
import {
  DiscordOneTimeBossLookupCommandAdapter,
  InMemoryOneTimeBossLookupSessionStore,
  OneTimeBossLookupCommandHandler,
  oneTimeBossLookupCommandDefinitions,
} from '../src/infrastructure/discord/one-time-boss-lookup-command.js';

describe('Discord one-time boss lookup command', () => {
  it('registers a separate guild-only slash command', () => {
    expect(oneTimeBossLookupCommandDefinitions[0]).toMatchObject({
      description: 'Look up an OSRS boss kill count for an unregistered account.',
      name: 'one-time-boss',
    });
  });

  it('collects username, mode, and boss before using a transient lookup target', async () => {
    const lookups = new LookupStub();
    const handler = new OneTimeBossLookupCommandHandler(lookups);
    const start = handler.start('guild-one', 'member-one');
    if (start.kind !== 'username_required') throw new Error('Expected username input.');
    const username = handler.submitUsername(
      'guild-one',
      'member-one',
      start.customId,
      'Unregistered Player',
    );
    if (username.kind !== 'mode_selection') throw new Error('Expected mode selection.');
    const mode = handler.selectMode(
      'guild-one',
      'member-one',
      username.customId,
      'hardcore_ironman',
    );
    if (mode.kind !== 'boss_selection') throw new Error('Expected boss selection.');
    await handler.selectBoss(
      'guild-one',
      'member-one',
      mode.customIds[0] ?? '',
      'Tombs of Amascut',
    );

    expect(lookups.requests).toEqual([
      {
        boss: 'Tombs of Amascut',
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        target: {
          accountMode: 'hardcore_ironman',
          kind: 'one_time_account',
          username: 'Unregistered Player',
        },
      },
    ]);
  });

  it('explains invalid boss input without attempting a lookup', async () => {
    const lookups = new LookupStub();
    const handler = new OneTimeBossLookupCommandHandler(lookups);
    const start = handler.start('guild-one', 'member-one');
    if (start.kind !== 'username_required') throw new Error('Expected username input.');
    const username = handler.submitUsername(
      'guild-one',
      'member-one',
      start.customId,
      'Unregistered Player',
    );
    if (username.kind !== 'mode_selection') throw new Error('Expected mode selection.');
    const mode = handler.selectMode('guild-one', 'member-one', username.customId, 'main');
    if (mode.kind !== 'boss_selection') throw new Error('Expected boss selection.');

    const result = await handler.selectBoss(
      'guild-one',
      'member-one',
      mode.customIds[0] ?? '',
      'Not an OSRS boss',
    );
    expect(result.kind).toBe('invalid_boss');
    if (result.kind === 'invalid_boss') expect(result.message).toContain('not supported');
    expect(lookups.requests).toEqual([]);
  });

  it('rejects another member and expired sessions without looking up an account', () => {
    const lookups = new LookupStub();
    const handler = new OneTimeBossLookupCommandHandler(lookups);
    const start = handler.start('guild-one', 'member-one');
    if (start.kind !== 'username_required') throw new Error('Expected username input.');
    expect(
      handler.submitUsername('guild-one', 'member-two', start.customId, 'Unregistered Player'),
    ).toMatchObject({ kind: 'forbidden' });

    const clock = new FakeClock();
    const expiringHandler = new OneTimeBossLookupCommandHandler(
      lookups,
      new InMemoryOneTimeBossLookupSessionStore(clock),
      clock,
    );
    const expiringStart = expiringHandler.start('guild-one', 'member-one');
    if (expiringStart.kind !== 'username_required') throw new Error('Expected username input.');
    clock.advance(5 * 60 * 1_000);
    expect(
      expiringHandler.submitUsername(
        'guild-one',
        'member-one',
        expiringStart.customId,
        'Unregistered Player',
      ),
    ).toMatchObject({ kind: 'expired' });
    expect(lookups.requests).toEqual([]);
  });

  it('keeps the guided interaction private and posts a found result publicly', async () => {
    const adapter = new DiscordOneTimeBossLookupCommandAdapter(
      new OneTimeBossLookupCommandHandler(new LookupStub()),
    );
    let usernameCustomId = '';
    await adapter.handle(
      commandInteraction((modal) => {
        usernameCustomId = modal.toJSON().custom_id;
        return Promise.resolve();
      }) as never,
    );

    let modeCustomId = '';
    const reply = vi.fn((result: ComponentResponse) => {
      const customId = result.components[0]?.components[0]?.data.custom_id;
      if (customId === undefined) throw new Error('Expected mode selector.');
      modeCustomId = customId;
      return Promise.resolve();
    });
    await adapter.handle(modalInteraction(usernameCustomId, reply) as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));

    let bossCustomId = '';
    let bossPlaceholders: string[] = [];
    const update = vi.fn((result: ComponentResponse) => {
      const customId = result.components[0]?.components[0]?.data.custom_id;
      if (customId === undefined) throw new Error('Expected boss selector.');
      bossCustomId = customId;
      bossPlaceholders = result.components.map(
        (component) => component.components[0]?.data.placeholder ?? '',
      );
      return Promise.resolve();
    });
    await adapter.handle(selectInteraction(modeCustomId, 'ironman', update) as never);
    expect(bossPlaceholders).toEqual([
      'Choose raid',
      'Choose boss (A–G)',
      'Choose boss (G–S)',
      'Choose boss (S–Z)',
    ]);
    const deferUpdate = vi.fn(() => Promise.resolve());
    const editReply = vi.fn<(result: FoundResponse) => Promise<void>>(() => Promise.resolve());
    const deleteReply = vi.fn(() => Promise.resolve());
    const send = vi.fn<(result: { embeds: unknown[] }) => Promise<void>>(() => Promise.resolve());
    await adapter.handle(
      bossSelectInteraction(
        bossCustomId,
        'Abyssal Sire',
        editReply,
        deferUpdate,
        deleteReply,
        send,
      ) as never,
    );

    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].embeds).toHaveLength(1);
    expect(deleteReply).toHaveBeenCalledOnce();
    expect(editReply).not.toHaveBeenCalled();
  });
});

class LookupStub {
  public readonly requests: unknown[] = [];

  public lookup = (request: unknown): Promise<BossLookupResult> => {
    this.requests.push(request);
    return Promise.resolve({
      boss: { id: 25, name: 'Abyssal Sire', rank: 42, score: 13 },
      kind: 'found',
      target: {
        accountMode: 'ironman',
        displayUsername: 'Unregistered Player',
        kind: 'one_time_account',
      },
    });
  };
}

class FakeClock {
  private current = new Date('2026-07-30T00:00:00.000Z');

  public now(): Date {
    return this.current;
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function commandInteraction(
  showModal: (modal: { toJSON(): { custom_id: string } }) => Promise<void>,
) {
  return {
    commandName: 'one-time-boss',
    guildId: 'guild-one',
    isChatInputCommand: () => true,
    showModal,
    user: { id: 'member-one' },
  };
}

function modalInteraction(customId: string, reply: (result: ComponentResponse) => Promise<void>) {
  return {
    customId,
    fields: { getTextInputValue: () => 'Unregistered Player' },
    guildId: 'guild-one',
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    reply,
    user: { id: 'member-one' },
  };
}

function selectInteraction(
  customId: string,
  value: string,
  update: (result: ComponentResponse) => Promise<void>,
) {
  return {
    customId,
    guildId: 'guild-one',
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    update,
    user: { id: 'member-one' },
    values: [value],
  };
}

function bossSelectInteraction(
  customId: string,
  value: string,
  editReply: (result: FoundResponse) => Promise<void>,
  deferUpdate: () => Promise<void>,
  deleteReply: () => Promise<void>,
  send: (result: { embeds: unknown[] }) => Promise<void>,
) {
  return {
    channel: { isSendable: () => true, send },
    customId,
    deferUpdate,
    deleteReply,
    editReply,
    guildId: 'guild-one',
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    user: { id: 'member-one' },
    values: [value],
  };
}

interface ComponentResponse {
  components: { components: { data: { custom_id: string; placeholder?: string } }[] }[];
}

interface FoundResponse {
  components: unknown[];
  embeds: unknown[];
}
