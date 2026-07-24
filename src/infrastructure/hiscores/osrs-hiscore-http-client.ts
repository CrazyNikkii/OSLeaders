import type { HiscoreFailure, HiscoreParseResult } from './hiscore-result.js';
import type { OsrsHiscoreEndpoint } from './osrs-hiscore-catalog.js';
import { parseHiscoreJson } from './parse-hiscore-response.js';

const DEFAULT_BASE_URL = 'https://secure.runescape.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 100;

type TransportFailure = Extract<
  HiscoreFailure,
  { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }
>;

export type OsrsHiscoreHttpResult = HiscoreParseResult | TransportFailure;

export interface OsrsHiscoreHttpClientOptions {
  baseUrl?: string;
  cacheTtlMs?: number;
  fetch?: typeof globalThis.fetch;
  maxConcurrentRequests?: number;
  maxCacheEntries?: number;
  now?: () => number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
}

export interface FetchHiscoresOptions {
  cacheMode?: 'default' | 'bypass';
}

type SuccessfulHiscoreResult = Extract<OsrsHiscoreHttpResult, { kind: 'success' }>;

interface CacheEntry {
  cachedAt: number;
  result: SuccessfulHiscoreResult;
}

export class OsrsHiscoreHttpClient {
  private readonly baseUrl: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly limiter: RequestLimiter;
  private readonly maxCacheEntries: number;
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly timeoutMs: number;

  public constructor(options: OsrsHiscoreHttpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.cacheTtlMs = positiveMilliseconds(
      options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      'Hiscore cache TTL',
    );
    this.fetch = options.fetch ?? globalThis.fetch;
    this.limiter = new RequestLimiter(
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    );
    this.maxCacheEntries = positiveSafeInteger(
      options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
      'Hiscore cache entry limit',
    );
    this.now = options.now ?? Date.now;
    this.retryDelayMs = positiveMilliseconds(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      'Hiscore retry delay',
    );
    this.sleep = options.sleep ?? delay;
    this.timeoutMs = positiveMilliseconds(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'Hiscore request timeout',
    );
  }

  public async fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
    options: FetchHiscoresOptions = {},
  ): Promise<OsrsHiscoreHttpResult> {
    const cacheKey = this.cacheKey(endpoint, username);
    if (options.cacheMode !== 'bypass') {
      const cached = this.readCached(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const firstAttempt = await this.limiter.run(() => this.fetchOnce(endpoint, username));
    if (firstAttempt.kind !== 'temporary_upstream_failure') {
      this.cacheSuccessfulResult(cacheKey, firstAttempt);
      return firstAttempt;
    }

    await this.sleep(this.retryDelayMs);
    const retriedAttempt = await this.limiter.run(() => this.fetchOnce(endpoint, username));
    this.cacheSuccessfulResult(cacheKey, retriedAttempt);
    return retriedAttempt;
  }

  private async fetchOnce(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
  ): Promise<OsrsHiscoreHttpResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(this.requestUrl(endpoint, username), {
        signal: controller.signal,
      });
      if (response.status === 404) {
        return { kind: 'not_found' };
      }

      if (!response.ok) {
        return { kind: 'temporary_upstream_failure' };
      }

      return parseHiscoreJson(await response.text());
    } catch {
      if (controller.signal.aborted) {
        return { kind: 'timeout' };
      }

      return { kind: 'temporary_upstream_failure' };
    } finally {
      clearTimeout(timeout);
    }
  }

  private requestUrl(endpoint: OsrsHiscoreEndpoint, username: string): string {
    const url = new URL(`/m=${endpoint}/index_lite.json`, `${this.baseUrl}/`);
    url.searchParams.set('player', username);
    return url.toString();
  }

  private cacheKey(endpoint: OsrsHiscoreEndpoint, username: string): string {
    return `${endpoint}:${normalizeUsernameForCache(username)}`;
  }

  private readCached(cacheKey: string): SuccessfulHiscoreResult | undefined {
    const entry = this.cache.get(cacheKey);
    if (entry === undefined) {
      return undefined;
    }

    if (this.now() - entry.cachedAt >= this.cacheTtlMs) {
      this.cache.delete(cacheKey);
      return undefined;
    }

    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    return entry.result;
  }

  private cacheSuccessfulResult(cacheKey: string, result: OsrsHiscoreHttpResult): void {
    if (result.kind !== 'success') {
      return;
    }

    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, { cachedAt: this.now(), result });
    if (this.cache.size > this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
  }
}

class RequestLimiter {
  private active = 0;
  private readonly pending: (() => void)[] = [];

  public constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error('Hiscore request concurrency must be a positive safe integer.');
    }
  }

  public async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    await this.acquire();

    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maximum) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => this.pending.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.pending.shift()?.();
  }
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function positiveMilliseconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer number of milliseconds.`);
  }

  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return value;
}

function normalizeUsernameForCache(username: string): string {
  return username
    .trim()
    .replace(/[\s_]+/g, ' ')
    .toLocaleLowerCase('en-US');
}
