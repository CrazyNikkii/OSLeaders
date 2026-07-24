import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadEnvironmentFileIfPresent } from '../src/infrastructure/config/environment-file.js';

const EXISTING_VARIABLE = 'OSLEADERS_ENV_FILE_TEST_EXISTING';
const FILE_ONLY_VARIABLE = 'OSLEADERS_ENV_FILE_TEST_FILE_ONLY';

describe('optional environment file loading', () => {
  it('loads missing values without overriding values supplied by the process', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'osleaders-env-file-'));
    const environmentFile = join(temporaryDirectory, '.env');
    const originalExistingValue = process.env[EXISTING_VARIABLE];
    const originalFileOnlyValue = process.env[FILE_ONLY_VARIABLE];

    try {
      await writeFile(
        environmentFile,
        `${EXISTING_VARIABLE}=file-value\n${FILE_ONLY_VARIABLE}=file-only-value\n`,
        'utf8',
      );
      process.env[EXISTING_VARIABLE] = 'process-value';
      delete process.env[FILE_ONLY_VARIABLE];

      loadEnvironmentFileIfPresent(environmentFile);

      expect(process.env[EXISTING_VARIABLE]).toBe('process-value');
      expect(process.env[FILE_ONLY_VARIABLE]).toBe('file-only-value');
    } finally {
      restoreEnvironmentValue(EXISTING_VARIABLE, originalExistingValue);
      restoreEnvironmentValue(FILE_ONLY_VARIABLE, originalFileOnlyValue);
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
