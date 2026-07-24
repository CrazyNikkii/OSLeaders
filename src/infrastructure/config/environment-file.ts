import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

/**
 * Loads one optional local environment file without overriding values that were
 * already supplied by the shell or CI.
 */
export function loadEnvironmentFileIfPresent(fileName: string): void {
  const filePath = resolve(process.cwd(), fileName);

  if (!existsSync(filePath)) {
    return;
  }

  const existingValues = new Map(Object.entries(process.env));
  loadEnvFile(filePath);

  for (const [name, value] of existingValues) {
    process.env[name] = value;
  }
}
