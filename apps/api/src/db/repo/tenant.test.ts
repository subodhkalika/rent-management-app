import { describe, it, expect } from 'vitest';
import { createDb } from '../index.js';
import { ApiException } from '../../lib/errors.js';
import {
  listTenantsQuery,
  getTenantQuery,
  createTenantQuery,
  updateTenantQuery,
  archiveTenantQuery,
  revokeLiveInvitesQuery,
  createInviteQuery,
  bindTenantUserQuery,
  markInviteAcceptedQuery,
  revokePortalAccessQuery,
} from './tenant.js';

/**
 * `.toSQL()` only compiles the query builder's AST to a SQL string — no network call,
 * no live database (see property.test.ts for the full rationale). That is enough to
 * prove, for every function here, that org B's orgId can never resolve to org A's
 * row: every WHERE clause below is asserted to reference `tenant.org_id` /
 * `tenant_invite.org_id`, and the bound parameter is whatever orgId the CALLER
 * passed in — never a value read back out of the row itself.
 */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('listTenantsQuery', () => {
  it("filters by tenant.org_id — org B's call can never return org A's tenants", () => {
    const { sql, params } = listTenantsQuery('org_A', db, { limit: 25 }).toSQL();
    expect(sql).toContain('"tenant"."org_id" =');
    expect(params).toContain('org_A');

    const other = listTenantsQuery('org_B', db, { limit: 25 }).toSQL();
    expect(other.params).toContain('org_B');
    expect(other.params).not.toContain('org_A');
  });

  it('excludes soft-deleted (archived) tenants', () => {
    const { sql } = listTenantsQuery('org_A', db, { limit: 25 }).toSQL();
    expect(sql).toContain('"tenant"."deleted_at" is null');
  });

  it("scopes the latest-invite join by org_id too, not just tenant_id", () => {
    // Otherwise a tenant_invite row for the SAME tenant_id in a different org (never
    // possible today, but nothing stops a future bug from creating one) could leak
    // its accepted/revoked state into this org's portalAccess derivation.
    const { sql } = listTenantsQuery('org_A', db, { limit: 25 }).toSQL();
    expect(sql).toMatch(/select distinct on \("tenant_invite"\."tenant_id"\)/);
    expect(sql).toContain('"tenant_invite"."org_id" =');
  });

  it('paginates with a keyset cursor when one is given', () => {
    const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    const cursor = btoa(id);
    const { sql, params } = listTenantsQuery('org_A', db, { limit: 10, cursor }).toSQL();
    expect(sql).toContain('"tenant"."id" >');
    expect(params).toContain(id);
  });

  it('rejects a malformed cursor instead of querying with it', () => {
    expect(() => listTenantsQuery('org_A', db, { limit: 10, cursor: 'not-valid' })).toThrow(ApiException);
  });
});

describe('getTenantQuery', () => {
  it("filters by tenant.org_id and tenant.id — org B holding org A's tenant UUID gets zero rows", () => {
    const { sql, params } = getTenantQuery('org_B', db, 'tenant_from_org_A').toSQL();
    expect(sql).toContain('"tenant"."org_id" =');
    expect(sql).toContain('"tenant"."id" =');
    expect(sql).toContain('"tenant"."deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_B', 'tenant_from_org_A']));
  });
});

const createBody = {
  firstName: 'Dana',
  lastName: 'Tenant',
  email: 'dana@example.com',
  status: 'prospect' as const,
};

describe('createTenantQuery', () => {
  it('inserts with the given org_id as one of the values, not a client-suppliable field', () => {
    const { sql, params } = createTenantQuery('org_A', db, 'tenant_1', createBody).toSQL();
    expect(sql).toContain('insert into "tenant"');
    expect(sql).toMatch(/\("id", "org_id",/);
    expect(params).toContain('org_A');
  });
});

describe('updateTenantQuery', () => {
  it("scopes the UPDATE by tenant.org_id and tenant.id — org B cannot update org A's tenant", () => {
    const { sql, params } = updateTenantQuery('org_B', db, 'tenant_from_org_A', { firstName: 'New' }).toSQL();
    expect(sql).toContain('update "tenant" set');
    expect(sql).toContain('"tenant"."org_id" =');
    expect(sql).toContain('"tenant"."id" =');
    expect(sql).toContain('"tenant"."deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_B', 'tenant_from_org_A']));
  });

  it('only sets fields present in the patch, plus updatedAt — notes is never silently cleared', () => {
    const { sql } = updateTenantQuery('org_A', db, 'tenant_1', { firstName: 'New' }).toSQL();
    expect(sql).toContain('"first_name" = $1');
    expect(sql).not.toContain('"notes" =');
  });
});

describe('archiveTenantQuery', () => {
  it("scopes the UPDATE by tenant.org_id and tenant.id — org B cannot archive org A's tenant", () => {
    const { sql, params } = archiveTenantQuery('org_B', db, 'tenant_from_org_A').toSQL();
    expect(sql).toContain('update "tenant" set "status"');
    expect(params).toContain('archived');
    expect(sql).toContain('"tenant"."org_id" =');
    expect(sql).toContain('"tenant"."id" =');
    expect(params).toEqual(expect.arrayContaining(['org_B', 'tenant_from_org_A']));
  });
});

describe('revokeLiveInvitesQuery', () => {
  it("scopes the UPDATE by tenant_invite.org_id and tenant_id — org B cannot revoke org A's invite", () => {
    const { sql, params } = revokeLiveInvitesQuery('org_B', db, 'tenant_from_org_A').toSQL();
    expect(sql).toContain('update "tenant_invite" set "revoked_at"');
    expect(sql).toContain('"tenant_invite"."org_id" =');
    expect(sql).toContain('"tenant_invite"."tenant_id" =');
    expect(params).toEqual(expect.arrayContaining(['org_B', 'tenant_from_org_A']));
  });

  it('only touches invites that are not already accepted, revoked, or expired', () => {
    const { sql } = revokeLiveInvitesQuery('org_A', db, 'tenant_1').toSQL();
    expect(sql).toContain('"tenant_invite"."accepted_at" is null');
    expect(sql).toContain('"tenant_invite"."revoked_at" is null');
    expect(sql).toContain('"tenant_invite"."expires_at" >');
  });
});

describe('createInviteQuery', () => {
  it('inserts with the given org_id as one of the values', () => {
    const { sql, params } = createInviteQuery('org_A', db, 'invite_1', {
      tenantId: 'tenant_1',
      email: 'dana@example.com',
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date('2026-01-15T00:00:00.000Z'),
      createdByUserId: 'user_1',
    }).toSQL();
    expect(sql).toContain('insert into "tenant_invite"');
    expect(sql).toMatch(/\("id", "org_id", "tenant_id",/);
    expect(params).toContain('org_A');
  });
});

describe('bindTenantUserQuery', () => {
  it("scopes the UPDATE by tenant.org_id and tenant.id — org B cannot bind a login to org A's tenant", () => {
    const { sql, params } = bindTenantUserQuery('org_B', db, 'tenant_from_org_A', 'user_1').toSQL();
    expect(sql).toContain('update "tenant" set "user_id"');
    expect(sql).toContain('"tenant"."org_id" =');
    expect(sql).toContain('"tenant"."id" =');
    expect(params).toEqual(expect.arrayContaining(['org_B', 'tenant_from_org_A', 'user_1']));
  });

  it('never overwrites an already-bound tenant (requires user_id IS NULL first)', () => {
    const { sql } = bindTenantUserQuery('org_A', db, 'tenant_1', 'user_1').toSQL();
    expect(sql).toContain('"tenant"."user_id" is null');
  });
});

describe('markInviteAcceptedQuery', () => {
  it("scopes the UPDATE by tenant_invite.org_id and id — org B cannot mark org A's invite accepted", () => {
    const { sql, params } = markInviteAcceptedQuery('org_B', db, 'invite_from_org_A', 'user_1').toSQL();
    expect(sql).toContain('update "tenant_invite" set "accepted_at"');
    expect(sql).toContain('"tenant_invite"."org_id" =');
    expect(sql).toContain('"tenant_invite"."id" =');
    expect(params).toEqual(expect.arrayContaining(['org_B', 'invite_from_org_A', 'user_1']));
  });
});

describe('revokePortalAccessQuery', () => {
  it("scopes the UPDATE by tenant.org_id and tenant.id — org B cannot revoke org A's tenant's access", () => {
    const { sql, params } = revokePortalAccessQuery('org_B', db, 'tenant_from_org_A').toSQL();
    expect(sql).toContain('update "tenant" set "user_id"');
    expect(sql).toContain('"tenant"."org_id" =');
    expect(sql).toContain('"tenant"."id" =');
    expect(params).toEqual(expect.arrayContaining(['org_B', 'tenant_from_org_A']));
  });
});
