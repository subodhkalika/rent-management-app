import { describe, it, expect } from 'vitest';
import { createDb } from '../index.js';
import { ApiException } from '../../lib/errors.js';
import { listPropertiesQuery, getPropertyQuery } from './property.js';

/**
 * These tests never touch a network: `createDb` builds a lazy Neon HTTP client, and
 * `.toSQL()` only compiles the query builder's AST to a SQL string — it does not
 * execute. That's enough to prove the where-clause carries `orgId` and excludes
 * soft-deleted rows without a live database (see ARCHITECTURE.md and
 * db/repo/README.md — repo tests here rely on the guard test for runtime isolation).
 */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('listPropertiesQuery', () => {
  it('filters by org_id', () => {
    const { sql, params } = listPropertiesQuery('org_1', db, { limit: 25 }).toSQL();
    expect(sql).toContain('"org_id" =');
    expect(params).toContain('org_1');
  });

  it('excludes soft-deleted rows', () => {
    const { sql } = listPropertiesQuery('org_1', db, { limit: 25 }).toSQL();
    expect(sql).toContain('"deleted_at" is null');
  });

  it('paginates with a keyset cursor when one is given', () => {
    const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    const cursor = btoa(id);
    const { sql, params } = listPropertiesQuery('org_1', db, { limit: 10, cursor }).toSQL();
    expect(sql).toContain('"id" >');
    expect(params).toContain(id);
  });

  it('rejects a malformed cursor instead of querying with it', () => {
    expect(() => listPropertiesQuery('org_1', db, { limit: 10, cursor: 'not-valid' })).toThrow(
      ApiException,
    );
  });

  it('requests one more row than the page limit, to detect a next page', () => {
    const { sql } = listPropertiesQuery('org_1', db, { limit: 10 }).toSQL();
    expect(sql).toContain('limit $');
  });
});

describe('getPropertyQuery', () => {
  it('filters by org_id, id, and excludes soft-deleted rows', () => {
    const { sql, params } = getPropertyQuery('org_1', db, 'prop_1').toSQL();
    expect(sql).toContain('"org_id" =');
    expect(sql).toContain('"id" =');
    expect(sql).toContain('"deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'prop_1']));
  });
});
