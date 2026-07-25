export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogEntry {
  timestamp: string;
  severity: LogSeverity;
  operation: string;
  guildId?: string;
  errorReferenceId?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
}

export interface StructuredLocalLogger {
  write(entry: StructuredLogEntry): void;
}
