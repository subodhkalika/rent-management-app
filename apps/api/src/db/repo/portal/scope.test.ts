import { describe, it, expect } from 'vitest';
import { createDb } from '../../index.js';
import { resolveScopeQuery } from './scope.js';

/**
 * Asserts on `.toSQL()` of the REAL query builder `resolveScope` awaits — not a
 * hand-reconstruction of the same query inline in this file. An earlier version of
 * this test built its own copy of the query, which meant it could pass even if
 * `scope.ts` itself silently dropped a clause (e.g. the `status <> 'archived'`
 * filter) — exactly the kind of drift a `.toSQL()` assertion is supposed to make
 * impossible. See property.test.ts / unit.test.ts / tenant.test.ts for the same
 * split-builder pattern this now follows.
 */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('resolveScopeQuery', () => {
  it('filters by tenant.user_id — the only input, scoped to one caller', () => {
    const { sql, params } = resolveScopeQuery('user_1', db).toSQL();
    expect(sql).toContain('"tenant"."user_id" =');
    expect(params).toContain('user_1');
  });

  it('excludes soft-deleted tenant rows', () => {
    const { sql } = resolveScopeQuery('user_1', db).toSQL();
    expect(sql).toContain('"tenant"."deleted_at" is null');
  });

  it("excludes archived tenant rows — an archived tenant's scope disappears immediately", () => {
    const { sql, params } = resolveScopeQuery('user_1', db).toSQL();
    expect(sql).toContain('"tenant"."status" <>');
    expect(params).toContain('archived');
  });

  it('joins organization scoped by the tenant row itself, not a caller-suppliable id', () => {
    const { sql } = resolveScopeQuery('user_1', db).toSQL();
    expect(sql).toContain('inner join "organization" on "organization"."id" = "tenant"."org_id"');
  });
});
