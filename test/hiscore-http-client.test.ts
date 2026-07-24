import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import completeResponse from './fixtures/hiscores/complete-osrs-response.json' with { type: 'json' };
import { OsrsHiscoreHttpClient } from '../src/infrastructure/hiscores/osrs-hiscore-http-client.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe('OSRS Hiscores HTTP client', () => {
  it('constructs an encoded request and parses the successful JSON response', async () => {
    let requestedUrl: URL | undefined;
    const baseUrl = await startServer((request, response) => {
      requestedUrl = new URL(request.url ?? '', 'http://localhost');
      respondJson(response, completeResponse);
    });
    const client = new OsrsHiscoreHttpClient({ baseUrl });

    const result = await client.fetchHiscores('hiscore_oldschool', 'Enjoyer BTW & Co');

    expect(result).toMatchObject({ kind: 'success' });
    expect(requestedUrl).toMatchObject({
      pathname: '/m=hiscore_oldschool/index_lite.json',
      search: '?player=Enjoyer+BTW+%26+Co',
    });
  });

  it('returns not found without retrying', async () => {
    let requests = 0;
    const baseUrl = await startServer((_, response) => {
      requests += 1;
      response.writeHead(404).end();
    });
    const client = new OsrsHiscoreHttpClient({ baseUrl, sleep: () => Promise.resolve() });

    await expect(client.fetchHiscores('hiscore_oldschool', 'Missing Player')).resolves.toEqual({
      kind: 'not_found',
    });
    expect(requests).toBe(1);
  });

  it('retries one temporary upstream failure before returning the parsed response', async () => {
    let requests = 0;
    let sleeps = 0;
    const baseUrl = await startServer((_, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503).end();
        return;
      }

      respondJson(response, completeResponse);
    });
    const client = new OsrsHiscoreHttpClient({
      baseUrl,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });

    await expect(
      client.fetchHiscores('hiscore_oldschool', 'Fixture Player'),
    ).resolves.toMatchObject({
      kind: 'success',
    });
    expect(requests).toBe(2);
    expect(sleeps).toBe(1);
  });

  it('returns a temporary upstream failure after two failed attempts', async () => {
    let requests = 0;
    let sleeps = 0;
    const baseUrl = await startServer((_, response) => {
      requests += 1;
      response.writeHead(503).end();
    });
    const client = new OsrsHiscoreHttpClient({
      baseUrl,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });

    await expect(client.fetchHiscores('hiscore_oldschool', 'Unavailable Player')).resolves.toEqual({
      kind: 'temporary_upstream_failure',
    });
    expect(requests).toBe(2);
    expect(sleeps).toBe(1);
  });

  it('retries a thrown network error once', async () => {
    let requests = 0;
    const client = new OsrsHiscoreHttpClient({
      fetch: () => {
        requests += 1;
        return Promise.reject(new Error('Network unavailable'));
      },
      sleep: () => Promise.resolve(),
    });

    await expect(client.fetchHiscores('hiscore_oldschool', 'Offline Player')).resolves.toEqual({
      kind: 'temporary_upstream_failure',
    });
    expect(requests).toBe(2);
  });

  it('returns a timeout when the endpoint does not respond in time', async () => {
    const baseUrl = await startServer(() => undefined);
    const client = new OsrsHiscoreHttpClient({ baseUrl, timeoutMs: 20 });

    await expect(client.fetchHiscores('hiscore_oldschool', 'Slow Player')).resolves.toEqual({
      kind: 'timeout',
    });
  });

  it('limits concurrent outgoing requests', async () => {
    let active = 0;
    let maximumActive = 0;
    const responders: (() => void)[] = [];
    const baseUrl = await startServer((_, response) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      responders.push(() => {
        active -= 1;
        respondJson(response, completeResponse);
      });
    });
    const client = new OsrsHiscoreHttpClient({ baseUrl, maxConcurrentRequests: 2 });

    const requests = [
      client.fetchHiscores('hiscore_oldschool', 'One'),
      client.fetchHiscores('hiscore_oldschool', 'Two'),
      client.fetchHiscores('hiscore_oldschool', 'Three'),
    ];
    await waitFor(() => responders.length === 2);
    responders.splice(0).forEach((respond) => respond());
    await waitFor(() => responders.length === 1);
    responders.splice(0).forEach((respond) => respond());

    await expect(Promise.all(requests)).resolves.toEqual([
      expect.objectContaining({ kind: 'success' }),
      expect.objectContaining({ kind: 'success' }),
      expect.objectContaining({ kind: 'success' }),
    ]);
    expect(maximumActive).toBe(2);
  });

  it.each([
    ['request timeout', { timeoutMs: 0 }],
    ['retry delay', { retryDelayMs: -1 }],
  ])('rejects an invalid %s', (_, options) => {
    expect(() => new OsrsHiscoreHttpClient(options)).toThrow(/positive safe integer/);
  });
});

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not provide a TCP address.');
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

function respondJson(response: ServerResponse<IncomingMessage>, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
