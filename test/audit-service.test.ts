import { describe, expect, it } from 'vitest';

import { AuditService } from '../src/features/audit/audit-service.js';
import { shouldDeliverAdministrativeAuditEvent } from '../src/features/audit/administrative-audit-policy.js';
import { createErrorReferenceId } from '../src/features/audit/error-reference.js';
import {
  ConfiguredSecretAuditContextSanitizer,
  sanitizeAuditContext,
} from '../src/features/audit/sanitize-audit-context.js';
import {
  safeJsonStringify,
  StdoutStructuredLocalLogger,
} from '../src/infrastructure/logging/structured-local-logger.js';
import type {
  StructuredLocalLogger,
  StructuredLogEntry,
} from '../src/shared/structured-logging.js';

describe('administrative audit policy', () => {
  it('excludes routine command events in standard mode', () => {
    expect(
      shouldDeliverAdministrativeAuditEvent(
        auditEvent({ type: 'command', severity: 'info' }),
        'standard',
      ),
    ).toBe(false);
  });

  it('includes important events in standard mode and every event in verbose mode', () => {
    expect(
      shouldDeliverAdministrativeAuditEvent(
        auditEvent({ type: 'account-registration', severity: 'warn' }),
        'standard',
      ),
    ).toBe(true);
    expect(
      shouldDeliverAdministrativeAuditEvent(
        auditEvent({ type: 'command', severity: 'info' }),
        'verbose',
      ),
    ).toBe(true);
  });
});

describe('audit sanitization', () => {
  it('redacts sensitive fields and credential-bearing values while preserving useful context', () => {
    expect(
      sanitizeAuditContext({
        username: 'Rune Scape',
        discordToken: 'secret-token',
        apiKey: 'api-key-value',
        databaseUrl: 'postgresql://name:password@example.test/osleaders',
        environment: { SERVICE_API_KEY: 'environment-secret', LOG_LEVEL: 'info' },
        nested: { authorization: 'Bearer credential', result: 'accepted' },
        upstreamMessage: 'request used Bearer abc123',
      }),
    ).toEqual({
      username: 'Rune Scape',
      discordToken: '[REDACTED]',
      apiKey: '[REDACTED]',
      databaseUrl: '[REDACTED]',
      environment: '[REDACTED]',
      nested: { authorization: '[REDACTED]', result: 'accepted' },
      upstreamMessage: 'request used [REDACTED]',
    });
  });

  it('redacts stack traces and sensitive ephemeral content', () => {
    expect(
      sanitizeAuditContext({
        error: { stack: 'Error: internal details', message: 'safe summary' },
        ephemeralContent: 'private interaction response',
      }),
    ).toEqual({
      error: { stack: '[REDACTED]', message: 'safe summary' },
      ephemeralContent: '[REDACTED]',
    });
  });

  it('converts unsupported values and cycles into safe structured values', () => {
    const context: Record<string, unknown> = { accountId: 123n, missingValue: undefined };
    context.self = context;

    expect(sanitizeAuditContext(context)).toEqual({
      accountId: '123n',
      missingValue: '[UNDEFINED]',
      self: '[CIRCULAR]',
    });
  });
});

describe('audit service', () => {
  it('writes a sanitized structured local log entry', () => {
    const logger = new RecordingLogger();
    const service = new AuditService(logger, new ConfiguredSecretAuditContextSanitizer([]));

    const entry = service.record(
      auditEvent({
        context: { accountName: 'Rune Scape', token: 'must-not-leak' },
        durationMs: 42,
        errorReferenceId: 'err_abc123',
        guildId: 'guild-one',
      }),
    );

    expect(entry).toEqual({
      timestamp: '2026-07-24T12:34:56.000Z',
      severity: 'info',
      operation: 'account.register',
      guildId: 'guild-one',
      errorReferenceId: 'err_abc123',
      durationMs: 42,
      context: { accountName: 'Rune Scape', token: '[REDACTED]' },
    });
    expect(logger.entries).toEqual([entry]);
  });

  it('does not fail the observed operation when a local logger throws', () => {
    const service = new AuditService(
      new ThrowingLogger(),
      new ConfiguredSecretAuditContextSanitizer([]),
    );

    expect(() => service.record(auditEvent({ context: { accountId: 123n } }))).not.toThrow();
  });
});

describe('stdout structured local logger', () => {
  it('serializes unsupported values and cycles without throwing', () => {
    const entry: Record<string, unknown> = { accountId: 123n };
    entry.self = entry;

    expect(safeJsonStringify(entry)).toBe('{"accountId":"123n","self":"[CIRCULAR]"}');
  });

  it('preserves repeated non-cyclic object references', () => {
    const account = { id: 'account-one' };

    expect(safeJsonStringify({ first: account, second: account })).toBe(
      '{"first":{"id":"account-one"},"second":{"id":"account-one"}}',
    );
  });

  it('does not throw when the output stream rejects a log write', () => {
    const logger = new StdoutStructuredLocalLogger({
      write() {
        throw new Error('stdout is unavailable');
      },
    });

    expect(() =>
      logger.write({ timestamp: '2026-07-25T00:00:00.000Z', severity: 'info', operation: 'test' }),
    ).not.toThrow();
  });
});

describe('error references', () => {
  it('creates short random identifiers suitable for correlating sanitized errors', () => {
    const reference = createErrorReferenceId();

    expect(reference).toMatch(/^err_[a-f0-9]{12}$/);
  });
});

describe('configured secret redaction', () => {
  it('redacts configured secret values even under neutral keys and within strings', () => {
    const sanitizer = new ConfiguredSecretAuditContextSanitizer([
      'discord-secret-token',
      'postgresql://name:password@example.test/osleaders',
    ]);

    expect(
      sanitizer.sanitize({
        detail: 'Discord rejected discord-secret-token while connecting.',
        connectionDetail: 'retry postgresql://name:password@example.test/osleaders now',
      }),
    ).toEqual({
      detail: 'Discord rejected [REDACTED] while connecting.',
      connectionDetail: 'retry [REDACTED] now',
    });
  });
});

class RecordingLogger implements StructuredLocalLogger {
  public readonly entries: StructuredLogEntry[] = [];

  public write(entry: StructuredLogEntry): void {
    this.entries.push(entry);
  }
}

function auditEvent(
  overrides: Partial<Parameters<AuditService['record']>[0]>,
): Parameters<AuditService['record']>[0] {
  return {
    type: 'account-registration',
    severity: 'info',
    operation: 'account.register',
    occurredAt: new Date('2026-07-24T12:34:56.000Z'),
    ...overrides,
  };
}

class ThrowingLogger implements StructuredLocalLogger {
  public write(): void {
    throw new Error('stdout is unavailable');
  }
}
