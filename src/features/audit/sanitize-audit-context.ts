const REDACTED_VALUE = '[REDACTED]';
const CIRCULAR_VALUE = '[CIRCULAR]';
const UNDEFINED_VALUE = '[UNDEFINED]';
const sensitiveKeyPattern =
  /(?:api.?key|authorization|credential|cookie|database.*url|dsn|ephemeral|environment|password|secret|stack|token)/i;
const databaseUrlPattern = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/\S+/gi;
const bearerTokenPattern = /\bbearer\s+\S+/gi;

export interface AuditContextSanitizer {
  sanitize(context: Record<string, unknown>): Record<string, unknown>;
}

export class ConfiguredSecretAuditContextSanitizer implements AuditContextSanitizer {
  private readonly configuredSecretValues: readonly string[];

  public constructor(configuredSecretValues: readonly string[]) {
    this.configuredSecretValues = [...new Set(configuredSecretValues)]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length);
  }

  public sanitize(context: Record<string, unknown>): Record<string, unknown> {
    return sanitizeRecord(context, new WeakSet<object>(), this.configuredSecretValues) as Record<
      string,
      unknown
    >;
  }
}

export function sanitizeAuditContext(
  context: Record<string, unknown>,
  configuredSecretValues: readonly string[] = [],
): Record<string, unknown> {
  return new ConfiguredSecretAuditContextSanitizer(configuredSecretValues).sanitize(context);
}

function sanitizeRecord(
  record: Record<string, unknown>,
  ancestors: WeakSet<object>,
  configuredSecretValues: readonly string[],
): unknown {
  if (ancestors.has(record)) {
    return CIRCULAR_VALUE;
  }

  ancestors.add(record);
  const sanitized = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      sensitiveKeyPattern.test(key)
        ? REDACTED_VALUE
        : sanitizeValue(value, ancestors, configuredSecretValues),
    ]),
  );
  ancestors.delete(record);
  return sanitized;
}

function sanitizeValue(
  value: unknown,
  ancestors: WeakSet<object>,
  configuredSecretValues: readonly string[],
): unknown {
  if (value === undefined) {
    return UNDEFINED_VALUE;
  }

  if (typeof value === 'string') {
    const sanitized = value
      .replace(databaseUrlPattern, REDACTED_VALUE)
      .replace(bearerTokenPattern, REDACTED_VALUE);

    return configuredSecretValues.reduce(
      (result, configuredSecretValue) => result.replaceAll(configuredSecretValue, REDACTED_VALUE),
      sanitized,
    );
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

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return CIRCULAR_VALUE;
    }

    ancestors.add(value);
    const sanitized = value.map((entry) => sanitizeValue(entry, ancestors, configuredSecretValues));
    ancestors.delete(value);
    return sanitized;
  }

  if (isRecord(value)) {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? '[UNSUPPORTED: Invalid Date]' : value.toISOString();
    }

    return sanitizeRecord(value, ancestors, configuredSecretValues);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
