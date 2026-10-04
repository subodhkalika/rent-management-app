import { describe, it, expect, afterEach } from 'vitest';
import { neonConfig } from '@neondatabase/serverless';
import { createDb } from './index.js';

/**
 * `neonConfig.fetchEndpoint` is global module state, so reset it after every test —
 * otherwise a test that sets the local override would leak into whichever test runs
 * next and change this module's default-endpoint assertion.
 */
const defaultFetchEndpoint = neonConfig.fetchEndpoint;

afterEach(() => {
  neonConfig.fetchEndpoint = defaultFetchEndpoint;
});

describe('createDb', () => {
  it('leaves neonConfig.fetchEndpoint untouched when NEON_LOCAL_FETCH_ENDPOINT is absent', () => {
    createDb('postgres://user:pass@localhost:5432/db');

    expect(neonConfig.fetchEndpoint).toBe(defaultFetchEndpoint);
  });

  it('leaves neonConfig.fetchEndpoint untouched when it is an empty string', () => {
    createDb('postgres://user:pass@localhost:5432/db', '');

    expect(neonConfig.fetchEndpoint).toBe(defaultFetchEndpoint);
  });

  it('points neonConfig.fetchEndpoint at the local proxy when NEON_LOCAL_FETCH_ENDPOINT is set', () => {
    createDb('postgres://user:pass@localhost:5432/db', 'http://db-proxy:4444/sql');

    expect(neonConfig.fetchEndpoint).toBe('http://db-proxy:4444/sql');
  });
});
