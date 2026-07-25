import type { StructuredLocalLogger, StructuredLogEntry } from '../../shared/structured-logging.js';

export type { StructuredLocalLogger, StructuredLogEntry } from '../../shared/structured-logging.js';

export class StdoutStructuredLocalLogger implements StructuredLocalLogger {
  public constructor(private readonly output: LocalLogOutput = process.stdout) {}

  public write(entry: StructuredLogEntry): void {
    try {
      this.output.write(`${safeJsonStringify(entry)}\n`);
    } catch {
      // Local logging must not disrupt the product operation it observes.
    }
  }
}

export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(toJsonSafeValue(value, new WeakSet<object>()));
}

interface LocalLogOutput {
  write(value: string): unknown;
}

function toJsonSafeValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === undefined) {
    return '[UNDEFINED]';
  }

  if (typeof value === 'bigint') {
    return `${value}n`;
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return `[UNSUPPORTED: ${typeof value}]`;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return `[UNSUPPORTED: ${String(value)}]`;
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (ancestors.has(value)) {
    return '[CIRCULAR]';
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[UNSUPPORTED: Invalid Date]' : value.toISOString();
  }

  ancestors.add(value);
  const safeValue = Array.isArray(value)
    ? value.map((entry) => toJsonSafeValue(entry, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, toJsonSafeValue(entry, ancestors)]),
      );
  ancestors.delete(value);
  return safeValue;
}
