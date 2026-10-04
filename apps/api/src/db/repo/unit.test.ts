import { describe, it, expect } from 'vitest';
import { createDb } from '../index.js';
import { ApiException } from '../../lib/errors.js';
import {
  listUnitsQuery,
  getUnitQuery,
  createUnitQuery,
  updateUnitQuery,
  softDeleteUnitQuery,
  softDeleteUnitsByPropertyQuery,
} from './unit.js';

/** See property.test.ts for why `.toSQL()` against this client never touches a
 *  network — it only compiles the query, it doesn't run it. */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('listUnitsQuery', () => {
  it('filters by unit.org_id and unit.property_id', () => {
    const { sql, params } = listUnitsQuery('org_1', db, 'prop_1', { limit: 25 }).toSQL();
    expect(sql).toContain('"unit"."org_id" =');
    expect(sql).toContain('"unit"."property_id" =');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'prop_1']));
  });

  it('excludes soft-deleted rows', () => {
    const { sql } = listUnitsQuery('org_1', db, 'prop_1', { limit: 25 }).toSQL();
    expect(sql).toContain('"unit"."deleted_at" is null');
  });

  it('paginates with a keyset cursor when one is given', () => {
    const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    const cursor = btoa(id);
    const { sql, params } = listUnitsQuery('org_1', db, 'prop_1', { limit: 10, cursor }).toSQL();
    expect(sql).toContain('"unit"."id" >');
    expect(params).toContain(id);
  });

  it('rejects a malformed cursor instead of querying with it', () => {
    expect(() =>
      listUnitsQuery('org_1', db, 'prop_1', { limit: 10, cursor: 'not-valid' }),
    ).toThrow(ApiException);
  });
});

describe('getUnitQuery', () => {
  it('filters by unit.org_id, unit.id, and excludes soft-deleted rows', () => {
    const { sql, params } = getUnitQuery('org_1', db, 'unit_1').toSQL();
    expect(sql).toContain('"unit"."org_id" =');
    expect(sql).toContain('"unit"."id" =');
    expect(sql).toContain('"unit"."deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'unit_1']));
  });

  it("also requires the unit's property to be live (not soft-deleted), scoped to this org", () => {
    // softDeleteProperty cascades deletedAt onto its units in the same call, but
    // this is belt-and-suspenders: it closes the gap for anything that reaches a
    // unit by id alone and would otherwise only need the cascade to have run.
    const { sql, params } = getUnitQuery('org_1', db, 'unit_1').toSQL();
    expect(sql).toContain('"unit"."property_id" in (select "id" from "property" where');
    expect(sql).toContain('"property"."org_id" =');
    expect(sql).toContain('"property"."deleted_at" is null');
    expect(params).toContain('org_1');
  });
});

const createBody = {
  label: '2B',
  bedrooms: 2,
  bathrooms: 1.5,
  marketRentCents: 150_000,
  currency: 'USD' as const,
  status: 'vacant' as const,
};

describe('createUnitQuery', () => {
  it('inserts with the given org_id as one of the values, not a client-suppliable field', () => {
    const { sql, params } = createUnitQuery('org_1', db, 'prop_1', 'unit_1', createBody).toSQL();
    expect(sql).toContain('insert into "unit"');
    expect(sql).toMatch(/\("id", "org_id", "property_id",/);
    expect(params).toEqual(expect.arrayContaining(['org_1', 'prop_1']));
  });
});

describe('updateUnitQuery', () => {
  it('scopes the UPDATE by unit.org_id, unit.id, excludes soft-deleted rows, and requires a live property', () => {
    const { sql, params } = updateUnitQuery('org_1', db, 'unit_1', { label: 'New label' }).toSQL();
    expect(sql).toContain('update "unit" set');
    expect(sql).toContain('"unit"."org_id" =');
    expect(sql).toContain('"unit"."id" =');
    expect(sql).toContain('"unit"."deleted_at" is null');
    expect(sql).toContain('"unit"."property_id" in (select "id" from "property" where');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'unit_1']));
  });

  it('only sets fields present in the patch, plus updatedAt', () => {
    const { sql } = updateUnitQuery('org_1', db, 'unit_1', { label: 'New label' }).toSQL();
    expect(sql).toContain('"label" = $1');
    expect(sql).not.toContain('"bedrooms" =');
  });
});

describe('softDeleteUnitQuery', () => {
  it('scopes the UPDATE by unit.org_id, unit.id, excludes already-deleted rows, and requires a live property', () => {
    const { sql, params } = softDeleteUnitQuery('org_1', db, 'unit_1').toSQL();
    expect(sql).toContain('update "unit" set "deleted_at"');
    expect(sql).toContain('"unit"."org_id" =');
    expect(sql).toContain('"unit"."id" =');
    expect(sql).toContain('"unit"."deleted_at" is null');
    expect(sql).toContain('"unit"."property_id" in (select "id" from "property" where');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'unit_1']));
  });
});

describe('softDeleteUnitsByPropertyQuery', () => {
  it('scopes the bulk UPDATE by unit.org_id and unit.property_id, and excludes already-deleted rows', () => {
    // Used by softDeleteProperty (property.ts) to cascade deletedAt onto a
    // property's units in the same call it soft-deletes the property itself.
    const { sql, params } = softDeleteUnitsByPropertyQuery('org_1', db, 'prop_1').toSQL();
    expect(sql).toContain('update "unit" set "deleted_at"');
    expect(sql).toContain('"unit"."org_id" =');
    expect(sql).toContain('"unit"."property_id" =');
    expect(sql).toContain('"unit"."deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'prop_1']));
  });
});
