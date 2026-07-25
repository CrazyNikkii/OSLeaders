import type { AdministrativeLogMode } from '../guild-configuration/guild-configuration-service.js';

import type { AuditEvent } from './audit-event.js';

const STANDARD_AUDIT_EVENT_TYPES: ReadonlySet<AuditEvent['type']> = new Set([
  'account-edit-or-deletion',
  'account-reassignment',
  'account-registration',
  'competition-lifecycle',
  'configuration-change',
  'error',
  'permission-failure',
  'recap-or-scheduling-failure',
  'role-management-failure',
]);

export function shouldDeliverAdministrativeAuditEvent(
  event: AuditEvent,
  mode: AdministrativeLogMode,
): boolean {
  return mode === 'verbose' || STANDARD_AUDIT_EVENT_TYPES.has(event.type);
}
