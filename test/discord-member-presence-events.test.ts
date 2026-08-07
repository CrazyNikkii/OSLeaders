import { Events } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  bindDiscordMemberPresenceEventAdapter,
  DiscordMemberPresenceEventAdapter,
} from '../src/infrastructure/discord/member-presence-events.js';

describe('Discord member presence events', () => {
  it('marks a configured-guild member present when they join and absent when they leave', async () => {
    const memberPresence = new RecordingMemberPresence();
    const adapter = new DiscordMemberPresenceEventAdapter(memberPresence);
    const client = new RecordingClient();

    bindDiscordMemberPresenceEventAdapter(
      client as never,
      adapter,
      () => undefined,
      (member) => member.guild.id === 'guild-one',
    );

    client.emit(Events.GuildMemberAdd, member('guild-one', 'member-one'));
    client.emit(Events.GuildMemberRemove, member('guild-one', 'member-one'));

    await vi.waitFor(() =>
      expect(memberPresence.calls).toEqual([
        { guildId: 'guild-one', kind: 'present', userId: 'member-one' },
        { guildId: 'guild-one', kind: 'absent', userId: 'member-one' },
      ]),
    );
  });

  it('ignores member events from another guild', async () => {
    const memberPresence = new RecordingMemberPresence();
    const client = new RecordingClient();

    bindDiscordMemberPresenceEventAdapter(
      client as never,
      new DiscordMemberPresenceEventAdapter(memberPresence),
      () => undefined,
      (member) => member.guild.id === 'guild-one',
    );

    client.emit(Events.GuildMemberAdd, member('guild-two', 'member-one'));
    client.emit(Events.GuildMemberRemove, member('guild-two', 'member-one'));

    await Promise.resolve();
    expect(memberPresence.calls).toEqual([]);
  });

  it('keeps rapid leave and rejoin writes ordered for the same member', async () => {
    const absent = deferred<ReturnType<typeof presence>>();
    const memberPresence = {
      markAbsent: vi.fn(() => absent.promise),
      markPresent: vi.fn(() => Promise.resolve(presence())),
    };
    const client = new RecordingClient();

    bindDiscordMemberPresenceEventAdapter(
      client as never,
      new DiscordMemberPresenceEventAdapter(memberPresence),
      () => undefined,
    );

    client.emit(Events.GuildMemberRemove, member('guild-one', 'member-one'));
    client.emit(Events.GuildMemberAdd, member('guild-one', 'member-one'));

    await vi.waitFor(() => expect(memberPresence.markAbsent).toHaveBeenCalledOnce());
    expect(memberPresence.markPresent).not.toHaveBeenCalled();
    absent.resolve(presence());
    await vi.waitFor(() => expect(memberPresence.markPresent).toHaveBeenCalledOnce());
  });

  it('reports a presence write failure without throwing from the Discord event listener', async () => {
    const error = new Error('database unavailable');
    const onError = vi.fn();
    const client = new RecordingClient();

    bindDiscordMemberPresenceEventAdapter(
      client as never,
      new DiscordMemberPresenceEventAdapter({
        markAbsent: () => Promise.resolve(presence()),
        markPresent: () => Promise.reject(error),
      }),
      onError,
    );

    expect(() =>
      client.emit(Events.GuildMemberAdd, member('guild-one', 'member-one')),
    ).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  });
});

class RecordingClient {
  private readonly listeners = new Map<Events, ((member: never) => void)[]>();

  public on(event: Events, listener: (member: never) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  public emit(event: Events, value: object): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value as never);
    }
  }
}

class RecordingMemberPresence {
  public readonly calls: { guildId: string; kind: 'absent' | 'present'; userId: string }[] = [];

  public markAbsent(guildId: string, userId: string) {
    this.calls.push({ guildId, kind: 'absent', userId });
    return Promise.resolve(presence());
  }

  public markPresent(guildId: string, userId: string) {
    this.calls.push({ guildId, kind: 'present', userId });
    return Promise.resolve(presence());
  }
}

function member(guildId: string, userId: string) {
  return { guild: { id: guildId }, user: { id: userId } };
}

function presence() {
  return {
    discordUserId: 'member-one',
    guildId: 'guild-one',
    isPresent: true,
    updatedAt: new Date(),
  };
}

function deferred<Value>() {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve(value: Value): void {
      resolve?.(value);
    },
  };
}
