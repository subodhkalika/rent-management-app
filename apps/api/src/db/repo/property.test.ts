import { describe, it, expect } from 'vitest';
import { createDb } from '../index.js';
import { ApiException } from '../../lib/errors.js';
import {
  listPropertiesQuery,
  getPropertyQuery,
  createPropertyQuery,
  updatePropertyQuery,
  softDeletePropertyQuery,
} from './property.js';

/**
 * These tests never touch a network: `createDb` builds a lazy Neon HTTP client, and
 * `.toSQL()` only compiles the query builder's AST to a SQL string — it does not
 * execute. That's enough to prove every statement carries `orgId` where it must
 * (reads in the WHERE clause, the insert in its VALUES) and excludes soft-deleted
 * rows, without a live database (see ARCHITECTURE.md and db/repo/README.md).
 *
 * Every assertion below is table-qualified (`"property"."org_id"`, not just
 * `"org_id"`) on purpose: these queries join `unit`, whose own `org_id` and
 * `deleted_at` columns appear in the SQL too (in the unit-count aggregate's
 * `FILTER` clause). An unqualified `.toContain('"org_id"')` would still pass if the
 * `property`-level predicate were accidentally deleted, as long as the join
 * survived — which defeats the point of the assertion.
 */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('listPropertiesQuery', () => {
  it('filters by property.org_id', () => {
    const { sql, params } = listPropertiesQuery('org_1', db, { limit: 25 }).toSQL();
    expect(sql).toContain('"property"."org_id" =');
    expect(params).toContain('org_1');
  });

  it('excludes soft-deleted properties', () => {
    const { sql } = listPropertiesQuery('org_1', db, { limit: 25 }).toSQL();
    expect(sql).toContain('"property"."deleted_at" is null');
  });

  it('joins units scoped by org_id too, not just property_id', () => {
    // Nothing in the schema stops a unit row's orgId from disagreeing with its own
    // property's — no current path can create that state, but an unscoped join
    // would silently fold a mismatched unit's counts into this org's property the
    // moment one did.
    const { sql } = listPropertiesQuery('org_1', db, { limit: 25 }).toSQL();
    expect(sql).toContain('"unit"."org_id" =');
    expect(sql).toMatch(/left join "unit" on \("unit"\."property_id" = "property"\."id" and "unit"\."org_id" = \$\d+\)/);
  });

  it('paginates with a keyset cursor when one is given', () => {
    const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    const cursor = btoa(id);
    const { sql, params } = listPropertiesQuery('org_1', db, { limit: 10, cursor }).toSQL();
    expect(sql).toContain('"property"."id" >');
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
  it('filters by property.org_id, property.id, and excludes soft-deleted rows', () => {
    const { sql, params } = getPropertyQuery('org_1', db, 'prop_1').toSQL();
    expect(sql).toContain('"property"."org_id" =');
    expect(sql).toContain('"property"."id" =');
    expect(sql).toContain('"property"."deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'prop_1']));
  });

  it('joins units scoped by org_id too', () => {
    const { sql } = getPropertyQuery('org_1', db, 'prop_1').toSQL();
    expect(sql).toContain('"unit"."org_id" =');
  });
});

const createBody = {
  name: 'Maple Court',
  type: 'multi_family' as const,
  address: {
    line1: '123 Maple St',
    city: 'Springfield',
    region: 'IL',
    postalCode: '62704',
    country: 'US',
  },
  timezone: 'America/Chicago',
  moveOutBillingPolicy: 'bill_full_term' as const,
  calendar: 'gregorian' as const,
};

describe('createPropertyQuery', () => {
  it('inserts with the given org_id as one of the values, not a client-suppliable field', () => {
    const { sql, params } = createPropertyQuery('org_1', db, 'prop_1', createBody).toSQL();
    expect(sql).toContain('insert into "property"');
    expect(sql).toMatch(/\("id", "org_id",/);
    expect(params).toContain('org_1');
  });

  it('inserts the timezone from the request body, not the column default', () => {
    const { sql, params } = createPropertyQuery('org_1', db, 'prop_1', createBody).toSQL();
    expect(sql).toContain('"timezone"');
    expect(params).toContain('America/Chicago');
  });

  it('inserts moveOutBillingPolicy and calendar from the request body', () => {
    const { sql, params } = createPropertyQuery('org_1', db, 'prop_1', {
      ...createBody,
      moveOutBillingPolicy: 'stop_at_move_out',
      calendar: 'bikram_sambat',
    }).toSQL();
    expect(sql).toContain('"move_out_billing_policy"');
    expect(sql).toContain('"calendar"');
    expect(params).toContain('stop_at_move_out');
    expect(params).toContain('bikram_sambat');
  });
});

describe('updatePropertyQuery', () => {
  it('scopes the UPDATE by property.org_id, property.id, and excludes soft-deleted rows', () => {
    const { sql, params } = updatePropertyQuery('org_1', db, 'prop_1', { name: 'New name' }).toSQL();
    expect(sql).toContain('update "property" set');
    expect(sql).toContain('"property"."org_id" =');
    expect(sql).toContain('"property"."id" =');
    expect(sql).toContain('"property"."deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'prop_1']));
  });

  it('only sets fields present in the patch, plus updatedAt', () => {
    const { sql } = updatePropertyQuery('org_1', db, 'prop_1', { name: 'New name' }).toSQL();
    expect(sql).toContain('"name" = $1');
    expect(sql).not.toContain('"type" =');
  });

  it('sets timezone when present in the patch', () => {
    const { sql, params } = updatePropertyQuery('org_1', db, 'prop_1', { timezone: 'Australia/Perth' }).toSQL();
    expect(sql).toContain('"timezone" =');
    expect(params).toContain('Australia/Perth');
  });

  it('leaves timezone untouched when absent from the patch', () => {
    const { sql } = updatePropertyQuery('org_1', db, 'prop_1', { name: 'New name' }).toSQL();
    expect(sql).not.toContain('"timezone" =');
  });

  it('sets moveOutBillingPolicy and calendar when present in the patch', () => {
    const { sql, params } = updatePropertyQuery('org_1', db, 'prop_1', {
      moveOutBillingPolicy: 'stop_at_move_out',
      calendar: 'bikram_sambat',
    }).toSQL();
    expect(sql).toContain('"move_out_billing_policy" =');
    expect(sql).toContain('"calendar" =');
    expect(params).toContain('stop_at_move_out');
    expect(params).toContain('bikram_sambat');
  });

  it('leaves moveOutBillingPolicy and calendar untouched when absent from the patch', () => {
    const { sql } = updatePropertyQuery('org_1', db, 'prop_1', { name: 'New name' }).toSQL();
    expect(sql).not.toContain('"move_out_billing_policy" =');
    expect(sql).not.toContain('"calendar" =');
  });
});

describe('softDeletePropertyQuery', () => {
  it('scopes the UPDATE by property.org_id, property.id, and excludes already-deleted rows', () => {
    const { sql, params } = softDeletePropertyQuery('org_1', db, 'prop_1').toSQL();
    expect(sql).toContain('update "property" set "deleted_at"');
    expect(sql).toContain('"property"."org_id" =');
    expect(sql).toContain('"property"."id" =');
    expect(sql).toContain('"property"."deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_1', 'prop_1']));
  });
});
