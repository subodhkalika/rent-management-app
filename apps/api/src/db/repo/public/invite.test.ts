import { describe, it, expect } from 'vitest';
import { createDb } from '../../index.js';
import { findInviteByTokenHashQuery } from './invite.js';

const db = createDb('postgres://user:pass@localhost:5432/db');

describe('findInviteByTokenHashQuery', () => {
  it('looks up by tenant_invite.token_hash alone — no org_id, no tenant_id, no email', () => {
    const { sql, params } = findInviteByTokenHashQuery(db, 'a'.repeat(64)).toSQL();
    expect(sql).toContain('"tenant_invite"."token_hash" =');
    expect(params).toContain('a'.repeat(64));
    // The only caller-supplied value bound anywhere in this query is the token hash
    // itself (plus the fixed `limit 1`) — function-signature enforcement of "no
    // orgId/tenantId parameter" lives in invite-lookup.guard.test.ts.
    expect(params.filter((p) => p !== 'a'.repeat(64))).toEqual([1]);
  });

  it('is a plain equality lookup, not a pattern match — no enumeration via partial token', () => {
    const { sql } = findInviteByTokenHashQuery(db, 'a'.repeat(64)).toSQL();
    expect(sql).not.toMatch(/like|ilike/i);
  });
});
