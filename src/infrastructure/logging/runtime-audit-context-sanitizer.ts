import type { RuntimeConfiguration } from '../config/runtime-environment.js';
import { ConfiguredSecretAuditContextSanitizer } from '../../features/audit/sanitize-audit-context.js';

export function createRuntimeAuditContextSanitizer(
  runtimeConfiguration: RuntimeConfiguration,
): ConfiguredSecretAuditContextSanitizer {
  return new ConfiguredSecretAuditContextSanitizer([
    runtimeConfiguration.database.connectionString,
    runtimeConfiguration.discord.token,
  ]);
}
