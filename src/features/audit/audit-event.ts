import type { LogSeverity } from '../../shared/structured-logging.js';

export const ADMINISTRATIVE_AUDIT_EVENT_TYPES = [
  'account-edit-or-deletion',
  'account-reassignment',
  'account-registration',
  'command',
  'competition-lifecycle',
  'configuration-change',
  'error',
  'permission-failure',
  'recap-or-scheduling-failure',
  'role-management-failure',
] as const;

export type AdministrativeAuditEventType = (typeof ADMINISTRATIVE_AUDIT_EVENT_TYPES)[number];

export interface AuditEvent {
  type: AdministrativeAuditEventType;
  severity: LogSeverity;
  operation: string;
  occurredAt: Date;
  guildId?: string;
  errorReferenceId?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
}
