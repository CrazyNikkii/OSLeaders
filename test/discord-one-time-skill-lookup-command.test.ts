import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { SkillLookupResult } from '../src/features/lookups/skill-lookup.js';
import {
  DiscordOneTimeSkillLookupCommandAdapter,
  InMemoryOneTimeSkillLookupSessionStore,
  OneTimeSkillLookupCommandHandler,
  oneTimeSkillLookupCommandDefinitions,
} from '../src/infrastructure/discord/one-time-skill-lookup-command.js';

describe('Discord one-time skill lookup command', () => {
  it('registers a separate guild-only slash command', () => {
    expect(oneTimeSkillLookupCommandDefinitions[0]).toMatchObject({
      description: 'Look up an OSRS skill for an unregistered account.',
      name: 'one-time-skill',
    });
  });

  it('collects username, mode, and skill before using a transient lookup target', async () => {
    const lookups = new LookupStub();
    const handler = new OneTimeSkillLookupCommandHandler(lookups);

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
    if (mode.kind !== 'skill_selection') throw new Error('Expected skill selection.');
    await handler.selectSkill('guild-one', 'member-one', mode.customId, 'Strength');

    expect(lookups.requests).toEqual([
      {
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        skill: 'Strength',
        target: {
          accountMode: 'hardcore_ironman',
          kind: 'one_time_account',
          username: 'Unregistered Player',
        },
      },
    ]);
  });

  it('rejects a session used by another member without making a lookup', () => {
    const lookups = new LookupStub();
    const handler = new OneTimeSkillLookupCommandHandler(lookups);
    const start = handler.start('guild-one', 'member-one');
    if (start.kind !== 'username_required') throw new Error('Expected username input.');

    expect(
      handler.submitUsername('guild-one', 'member-two', start.customId, 'Unregistered Player'),
    ).toMatchObject({ kind: 'forbidden' });
    expect(lookups.requests).toEqual([]);
  });

  it('expires sessions before they can trigger a lookup', () => {
    const clock = new FakeClock();
    const lookups = new LookupStub();
    const handler = new OneTimeSkillLookupCommandHandler(
      lookups,
      new InMemoryOneTimeSkillLookupSessionStore(clock),
      clock,
    );
    const start = handler.start('guild-one', 'member-one');
    if (start.kind !== 'username_required') throw new Error('Expected username input.');
    clock.advance(5 * 60 * 1_000);

    expect(
      handler.submitUsername('guild-one', 'member-one', start.customId, 'Unregistered Player'),
    ).toMatchObject({ kind: 'expired' });
    expect(lookups.requests).toEqual([]);
  });

  it('keeps the guided interaction private and renders the shared lookup result', async () => {
    const lookups = new LookupStub();
    const adapter = new DiscordOneTimeSkillLookupCommandAdapter(
      new OneTimeSkillLookupCommandHandler(lookups),
    );
    let usernameCustomId = '';
    const showModal = vi.fn((modal: { toJSON(): { custom_id: string } }) => {
      usernameCustomId = modal.toJSON().custom_id;
      return Promise.resolve();
    });
    await adapter.handle(commandInteraction(showModal) as never);

    let modeCustomId = '';
    const reply = vi.fn(
      (response: { components: { components: { data: { custom_id: string } }[] }[] }) => {
        modeCustomId = response.components[0]?.components[0]?.data.custom_id ?? '';
        return Promise.resolve();
      },
    );
    await adapter.handle(modalInteraction(usernameCustomId, reply) as never);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));

    let skillCustomId = '';
    const update = vi.fn(
      (response: { components: { components: { data: { custom_id: string } }[] }[] }) => {
        skillCustomId = response.components[0]?.components[0]?.data.custom_id ?? '';
        return Promise.resolve();
      },
    );
    await adapter.handle(selectInteraction(modeCustomId, 'ironman', update) as never);

    const deferUpdate = vi.fn(() => Promise.resolve());
    const responses: unknown[] = [];
    const editReply = vi.fn((response?: unknown) => {
      responses.push(response);
      return Promise.resolve();
    });
    await adapter.handle(
      selectInteraction(skillCustomId, 'Strength', update, deferUpdate, editReply) as never,
    );

    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(JSON.stringify(responses)).toContain('Strength: Unregistered Player');
  });
});

class LookupStub {
  public readonly requests: unknown[] = [];

  public lookup(request: unknown): Promise<SkillLookupResult> {
    this.requests.push(request);
    return Promise.resolve({
      kind: 'found',
      skill: { experience: 13_034_431, id: 2, level: 99, name: 'Strength', rank: 42 },
      target: {
        accountMode: 'ironman',
        displayUsername: 'Unregistered Player',
        kind: 'one_time_account',
      },
    });
  }
}

class FakeClock {
  private value = new Date('2026-07-30T00:00:00.000Z');
  public now(): Date {
    return this.value;
  }
  public advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

function commandInteraction(showModal: ReturnType<typeof vi.fn>) {
  return {
    commandName: 'one-time-skill',
    guildId: 'guild-one',
    isChatInputCommand: () => true,
    showModal,
    user: { id: 'member-one' },
  };
}

function modalInteraction(customId: string, reply: ReturnType<typeof vi.fn>) {
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
  update: ReturnType<typeof vi.fn>,
  deferUpdate = vi.fn(() => Promise.resolve()),
  editReply = vi.fn(() => Promise.resolve()),
) {
  return {
    customId,
    deferUpdate,
    editReply,
    guildId: 'guild-one',
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    update,
    user: { id: 'member-one' },
    values: [value],
  };
}
