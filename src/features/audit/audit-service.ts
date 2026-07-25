import type { StructuredLocalLogger, StructuredLogEntry } from '../../shared/structured-logging.js';

import type { AuditEvent } from './audit-event.js';
import type { AuditContextSanitizer } from './sanitize-audit-context.js';

export class AuditService {
  public constructor(
    private readonly localLogger: StructuredLocalLogger,
    private readonly contextSanitizer: AuditContextSanitizer,
  ) {}

  public record(event: AuditEvent): StructuredLogEntry {
    const entry: StructuredLogEntry = {
      timestamp: event.occurredAt.toISOString(),
      severity: event.severity,
      operation: event.operation,
      ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
      ...(event.errorReferenceId === undefined ? {} : { errorReferenceId: event.errorReferenceId }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.context === undefined
        ? {}
        : { context: this.contextSanitizer.sanitize(event.context) }),
    };

    try {
      this.localLogger.write(entry);
    } catch {
      // Logging is an optional side effect and must not undo a valid operation.
    }

    return entry;
  }
}
