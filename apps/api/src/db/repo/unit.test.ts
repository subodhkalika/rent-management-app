import { describe, it, expect } from 'vitest';
import { createDb } from '../index.js';
import { ApiException } from '../../lib/errors.js';
import { listUnitsQuery, getUnitQuery } from './unit.js';

/** See property.test.ts for why `.toSQL()` against this client never touches a
 *  network — it only compiles the query, it doesn't run it. */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('listUnitsQuery', () => {
  it('filters by org_id and property_id', () => {
    const { sql, params } = listUnitsQuery('org_1', db, 'prop_1', { limit: 25 }).toSQL();
    expect(sql).toContain('"org_id" =');
    expect(sql).toContain('"property_id" =');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'prop_1']));
  });

  it('excludes soft-deleted rows', () => {
    const { sql } = listUnitsQuery('org_1', db, 'prop_1', { limit: 25 }).toSQL();
    expect(sql).toContain('"deleted_at" is null');
  });

  it('paginates with a keyset cursor when one is given', () => {
    const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    const cursor = btoa(id);
    const { sql, params } = listUnitsQuery('org_1', db, 'prop_1', { limit: 10, cursor }).toSQL();
    expect(sql).toContain('"id" >');
    expect(params).toContain(id);
  });

  it('rejects a malformed cursor instead of querying with it', () => {
    expect(() =>
      listUnitsQuery('org_1', db, 'prop_1', { limit: 10, cursor: 'not-valid' }),
    ).toThrow(ApiException);
  });
});

describe('getUnitQuery', () => {
  it('filters by org_id, id, and excludes soft-deleted rows', () => {
    const { sql, params } = getUnitQuery('org_1', db, 'unit_1').toSQL();
    expect(sql).toContain('"org_id" =');
    expect(sql).toContain('"id" =');
    expect(sql).toContain('"deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'unit_1']));
  });
});
