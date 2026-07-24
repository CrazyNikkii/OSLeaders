import { describe, expect, it } from 'vitest';

import {
  assertDevelopmentMigrationEnvironment,
  assertSafeTestDatabaseUrl,
  assertTestResetEnvironment,
  parseRuntimeDatabaseConfiguration,
} from '../src/infrastructure/config/database-environment.js';

describe('database environment safety', () => {
  it('accepts normal runtime configuration without test configuration', () => {
    expect(
      parseRuntimeDatabaseConfiguration({
        DATABASE_POOL_MAX: '4',
        DATABASE_URL: 'postgresql://osleaders_dev:private@localhost:5432/osleaders_dev',
      }),
    ).toEqual({
      connectionString: 'postgresql://osleaders_dev:private@localhost:5432/osleaders_dev',
      poolMax: 4,
    });
  });

  it('rejects a test URL that targets the development database before connecting', () => {
    expect(() => {
      assertSafeTestDatabaseUrl('postgresql://osleaders_test:private@localhost:5432/osleaders_dev');
    }).toThrow('DATABASE_TEST_URL must target exactly osleaders_test.');
  });

  it('rejects a non-local test URL before connecting', () => {
    expect(() => {
      assertSafeTestDatabaseUrl(
        'postgresql://osleaders_test:private@example.com:5432/osleaders_test',
      );
    }).toThrow('DATABASE_TEST_URL must target a local PostgreSQL host.');
  });

  it('accepts a local development migration environment for osleaders_dev', () => {
    expect(() => {
      assertDevelopmentMigrationEnvironment({
        DATABASE_URL: 'postgresql://osleaders_dev:private@localhost:5432/osleaders_dev',
        NODE_ENV: 'development',
      });
    }).not.toThrow();
  });

  it('rejects development migrations aimed at osleaders_test', () => {
    expect(() => {
      assertDevelopmentMigrationEnvironment({
        DATABASE_URL: 'postgresql://osleaders_test:private@localhost:5432/osleaders_test',
        NODE_ENV: 'development',
      });
    }).toThrow('DATABASE_URL must target exactly osleaders_dev.');
  });

  it('rejects development migrations aimed at another database', () => {
    expect(() => {
      assertDevelopmentMigrationEnvironment({
        DATABASE_URL: 'postgresql://osleaders_dev:private@localhost:5432/another_database',
        NODE_ENV: 'development',
      });
    }).toThrow('DATABASE_URL must target exactly osleaders_dev.');
  });

  it('rejects development migrations aimed at a remote host', () => {
    expect(() => {
      assertDevelopmentMigrationEnvironment({
        DATABASE_URL: 'postgresql://osleaders_dev:private@example.com:5432/osleaders_dev',
        NODE_ENV: 'development',
      });
    }).toThrow('DATABASE_URL must target a local PostgreSQL host.');
  });

  it.each([undefined, 'test', 'production'])(
    'rejects development migrations when NODE_ENV is %s',
    (nodeEnvironment) => {
      expect(() => {
        assertDevelopmentMigrationEnvironment({
          DATABASE_URL: 'postgresql://osleaders_dev:private@localhost:5432/osleaders_dev',
          NODE_ENV: nodeEnvironment,
        });
      }).toThrow('Development migrations require NODE_ENV to be exactly development.');
    },
  );

  it('accepts NODE_ENV=test for the destructive test reset', () => {
    expect(() => {
      assertTestResetEnvironment({ NODE_ENV: 'test' });
    }).not.toThrow();
  });

  it.each([undefined, 'development', 'production'])(
    'rejects NODE_ENV=%s for the destructive test reset',
    (nodeEnvironment) => {
      expect(() => {
        assertTestResetEnvironment({ NODE_ENV: nodeEnvironment });
      }).toThrow('The test database reset requires NODE_ENV to be exactly test.');
    },
  );
});
