import { describe, it, expect } from 'vitest';
import { property as propertySchema, unit as unitSchema, tenant as tenantSchema, portalProfile as portalProfileSchema } from '@rms/contract';
import type { PropertyRow } from '../db/repo/property.js';
import type { UnitRow } from '../db/repo/unit.js';
import type { TenantRow } from '../db/repo/tenant.js';
import type { PortalProfileRow } from '../db/repo/portal/profile.js';
import { mapProperty, mapUnit, mapTenant, mapPortalProfile, derivePortalAccess } from './mappers.js';

const propertyRow: PropertyRow = {
  id: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  name: 'Maple Court',
  type: 'multi_family',
  addressLine1: '123 Maple St',
  addressLine2: null,
  city: 'Springfield',
  region: 'IL',
  postalCode: '62704',
  country: 'US',
  notes: null,
  timezone: 'Australia/Perth',
  unitCount: 4,
  occupiedUnitCount: 3,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

const unitRow: UnitRow = {
  id: '0191c2e4-2b3c-7d4e-9f5a-6b7c8d9e0f1a',
  orgId: 'org_1',
  propertyId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  label: '2B',
  bedrooms: 2,
  bathrooms: 1.5,
  squareFeet: 900,
  marketRentCents: 150_000,
  currency: 'USD',
  status: 'occupied',
  notes: 'Corner unit',
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('mapProperty', () => {
  it('produces a value matching the contract schema', () => {
    expect(propertySchema.safeParse(mapProperty(propertyRow)).success).toBe(true);
  });

  it('converts a null address line2 to undefined (contract treats it as optional, not nullable)', () => {
    expect(mapProperty(propertyRow).address.line2).toBeUndefined();
  });

  it('preserves a present address line2', () => {
    const withLine2 = mapProperty({ ...propertyRow, addressLine2: 'Unit 4' });
    expect(withLine2.address.line2).toBe('Unit 4');
  });

  it('formats timestamps as ISO strings', () => {
    expect(mapProperty(propertyRow).createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never leaks orgId or deletedAt', () => {
    const mapped = mapProperty(propertyRow) as Record<string, unknown>;
    expect(mapped.orgId).toBeUndefined();
    expect(mapped.deletedAt).toBeUndefined();
  });
});

describe('mapUnit', () => {
  it('produces a value matching the contract schema', () => {
    expect(unitSchema.safeParse(mapUnit(unitRow)).success).toBe(true);
  });

  it('keeps money as an integer number of cents', () => {
    expect(mapUnit(unitRow).marketRentCents).toBe(150_000);
    expect(Number.isInteger(mapUnit(unitRow).marketRentCents)).toBe(true);
  });

  it('never leaks orgId or deletedAt', () => {
    const mapped = mapUnit(unitRow) as Record<string, unknown>;
    expect(mapped.orgId).toBeUndefined();
    expect(mapped.deletedAt).toBeUndefined();
  });
});

describe('derivePortalAccess', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const none = { userId: null, latestInviteAcceptedAt: null, latestInviteRevokedAt: null, latestInviteExpiresAt: null };

  it('is "none" when no invite was ever sent', () => {
    expect(derivePortalAccess(none, now)).toBe('none');
  });

  it('is "invited" when a live (unexpired, unaccepted, unrevoked) invite exists', () => {
    expect(
      derivePortalAccess({ ...none, latestInviteExpiresAt: new Date('2026-06-15T00:00:00.000Z') }, now),
    ).toBe('invited');
  });

  it('is "none" when the most recent invite expired without being accepted or revoked', () => {
    expect(
      derivePortalAccess({ ...none, latestInviteExpiresAt: new Date('2026-05-01T00:00:00.000Z') }, now),
    ).toBe('none');
  });

  it('is "revoked" when the most recent invite was revoked before acceptance', () => {
    expect(derivePortalAccess({ ...none, latestInviteRevokedAt: now }, now)).toBe('revoked');
  });

  it('is "active" whenever a login is bound, regardless of invite history', () => {
    expect(derivePortalAccess({ ...none, userId: 'user_1' }, now)).toBe('active');
  });

  it('is "revoked" once an accepted invite\'s tenant has had access pulled (userId cleared)', () => {
    // This is the state DELETE /v1/tenants/:id/portal-access leaves behind: the
    // historical invite keeps accepted_at set forever (append-only), but userId is
    // now null. That combination must read as "revoked", not "active" or "invited".
    expect(derivePortalAccess({ ...none, latestInviteAcceptedAt: now }, now)).toBe('revoked');
  });

  it('prefers "active" over every invite-history signal', () => {
    expect(
      derivePortalAccess(
        { userId: 'user_1', latestInviteAcceptedAt: now, latestInviteRevokedAt: now, latestInviteExpiresAt: now },
        now,
      ),
    ).toBe('active');
  });
});

const tenantRow: TenantRow = {
  id: '0191c2e4-3c4d-7e5f-af6b-7c8d9e0f1a2b',
  firstName: 'Dana',
  lastName: 'Lee',
  email: 'dana@example.com',
  phone: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  notes: 'Pays late in December, follow up proactively.',
  status: 'active',
  remindersOptedOut: false,
  userId: null,
  portalEmail: null,
  latestInviteEmail: null,
  latestInviteAcceptedAt: null,
  latestInviteRevokedAt: null,
  latestInviteExpiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('mapTenant', () => {
  it('produces a value matching the contract schema', () => {
    expect(tenantSchema.safeParse(mapTenant(tenantRow)).success).toBe(true);
  });

  it('includes notes for the LANDLORD-facing tenant shape (it is only banned from portal responses)', () => {
    expect(mapTenant(tenantRow).notes).toBe(tenantRow.notes);
  });

  it('never leaks userId or the raw invite columns', () => {
    const mapped = mapTenant(tenantRow) as Record<string, unknown>;
    expect(mapped.userId).toBeUndefined();
    expect(mapped.latestInviteAcceptedAt).toBeUndefined();
    expect(mapped.latestInviteRevokedAt).toBeUndefined();
    expect(mapped.latestInviteExpiresAt).toBeUndefined();
  });

  it('invitedEmail/inviteExpiresAt are null when portalAccess is "none"', () => {
    const mapped = mapTenant(tenantRow);
    expect(mapped.portalAccess).toBe('none');
    expect(mapped.invitedEmail).toBeNull();
    expect(mapped.inviteExpiresAt).toBeNull();
  });

  it('invitedEmail/inviteExpiresAt are populated only while portalAccess is "invited"', () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24);
    const invitedRow: TenantRow = {
      ...tenantRow,
      latestInviteEmail: 'dana@example.com',
      latestInviteExpiresAt: future,
    };
    const mapped = mapTenant(invitedRow);
    expect(mapped.portalAccess).toBe('invited');
    expect(mapped.invitedEmail).toBe('dana@example.com');
    expect(mapped.inviteExpiresAt).toBe(future.toISOString());
  });

  it('invitedEmail/inviteExpiresAt go back to null once access is "active" even if latestInvite* is still set', () => {
    const mapped = mapTenant({
      ...tenantRow,
      userId: 'user_1',
      latestInviteEmail: 'dana@example.com',
      latestInviteAcceptedAt: new Date('2026-01-01T00:00:00.000Z'),
      latestInviteExpiresAt: new Date('2026-06-15T00:00:00.000Z'),
    });
    expect(mapped.portalAccess).toBe('active');
    expect(mapped.invitedEmail).toBeNull();
    expect(mapped.inviteExpiresAt).toBeNull();
  });
});

const portalProfileRow: PortalProfileRow = {
  tenantId: '0191c2e4-3c4d-7e5f-af6b-7c8d9e0f1a2b',
  orgId: 'org_1',
  orgName: 'Alice Lettings',
  firstName: 'Dana',
  lastName: 'Lee',
  email: 'dana@example.com',
  phone: '555-0100',
  emergencyContactName: null,
  emergencyContactPhone: null,
  remindersOptedOut: false,
};

describe('mapPortalProfile', () => {
  it('produces a value matching the contract schema', () => {
    expect(portalProfileSchema.safeParse(mapPortalProfile(portalProfileRow)).success).toBe(true);
  });

  it('never leaks notes — there is no such field to leak (the row has none to map)', () => {
    const mapped = mapPortalProfile(portalProfileRow) as Record<string, unknown>;
    expect(mapped.notes).toBeUndefined();
  });
});
