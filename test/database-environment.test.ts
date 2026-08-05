import { describe, expect, it } from 'vitest';

import {
  assertDevelopmentMigrationEnvironment,
  assertProductionMigrationEnvironment,
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

  it('rejects an invalid runtime database URL before connecting', () => {
    expect(() => {
      parseRuntimeDatabaseConfiguration({
        DATABASE_POOL_MAX: '4',
        DATABASE_URL: 'not-a-database-url',
      });
    }).toThrow('DATABASE_URL must be a valid PostgreSQL connection URL.');
  });

  it('rejects the example runtime database URL before connecting', () => {
    expect(() => {
      parseRuntimeDatabaseConfiguration({
        DATABASE_POOL_MAX: '4',
        DATABASE_URL:
          'postgresql://REPLACE_WITH_USERNAME:REPLACE_WITH_PASSWORD@localhost:5432/osleaders_dev',
      });
    }).toThrow('DATABASE_URL must not use the example placeholder.');
  });

  it('rejects a runtime database URL with a non-PostgreSQL protocol', () => {
    expect(() => {
      parseRuntimeDatabaseConfiguration({
        DATABASE_POOL_MAX: '4',
        DATABASE_URL: 'https://localhost/osleaders_dev',
      });
    }).toThrow('DATABASE_URL must use the postgresql protocol.');
  });

  it('rejects a runtime database URL without an explicit database name', () => {
    expect(() => {
      parseRuntimeDatabaseConfiguration({
        DATABASE_POOL_MAX: '4',
        DATABASE_URL: 'postgresql://osleaders_dev:private@localhost:5432',
      });
    }).toThrow('DATABASE_URL must include a database name.');
  });

  it('rejects a remote runtime database URL before connecting', () => {
    expect(() => {
      parseRuntimeDatabaseConfiguration({
        DATABASE_POOL_MAX: '4',
        DATABASE_URL: 'postgresql://osleaders:private@example.com:5432/osleaders',
      });
    }).toThrow('DATABASE_URL must target a local PostgreSQL host.');
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

  it('accepts a separate local production migration database', () => {
    expect(() => {
      assertProductionMigrationEnvironment({
        DATABASE_URL: 'postgresql://osleaders:private@localhost:5432/osleaders_production',
        NODE_ENV: 'production',
      });
    }).not.toThrow();
  });

  it.each(['osleaders_dev', 'osleaders_test'])(
    'rejects production migrations aimed at %s',
    (databaseName) => {
      expect(() => {
        assertProductionMigrationEnvironment({
          DATABASE_URL: `postgresql://osleaders:private@localhost:5432/${databaseName}`,
          NODE_ENV: 'production',
        });
      }).toThrow('Production migrations must not target osleaders_dev or osleaders_test.');
    },
  );

  it.each([undefined, 'development', 'test'])(
    'rejects production migrations when NODE_ENV is %s',
    (nodeEnvironment) => {
      expect(() => {
        assertProductionMigrationEnvironment({
          DATABASE_URL: 'postgresql://osleaders:private@localhost:5432/osleaders_production',
          NODE_ENV: nodeEnvironment,
        });
      }).toThrow('Production migrations require NODE_ENV to be exactly production.');
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
