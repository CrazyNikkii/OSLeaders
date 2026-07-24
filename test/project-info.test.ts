import { describe, expect, it } from 'vitest';

import { PROJECT_NAME } from '../src/index.js';

describe('project foundation', () => {
  it('loads TypeScript source through the test runner', () => {
    expect(PROJECT_NAME).toBe('OSLeaders');
  });
});
