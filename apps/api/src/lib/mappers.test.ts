import { describe, it, expect } from 'vitest';
import {
  property as propertySchema,
  unit as unitSchema,
  tenant as tenantSchema,
  portalProfile as portalProfileSchema,
  rentStepSummary,
  rentStepCorrection,
  portalRentStep,
  charge as chargeSchema,
  chargeWithLease as chargeWithLeaseSchema,
  portalCharge as portalChargeSchema,
  payment as paymentSchema,
  portalPayment as portalPaymentSchema,
  allocatedCharge as allocatedChargeSchema,
  chainBalance as chainBalanceSchema,
  leaseBalanceSlice as leaseBalanceSliceSchema,
  leaseBalanceResponse as leaseBalanceResponseSchema,
  arrearsRow as arrearsRowSchema,
  arrearsResponse as arrearsResponseSchema,
  portalBalance as portalBalanceSchema,
} from '@rms/contract';
import type { PropertyRow } from '../db/repo/property.js';
import type { UnitRow } from '../db/repo/unit.js';
import type { TenantRow } from '../db/repo/tenant.js';
import type { PortalProfileRow } from '../db/repo/portal/profile.js';
import { escalationFromRow, type RentStepRow, type RentStepCorrectionRow } from '../db/repo/lease.js';
import type { ChargeRow, ChargeWithLeaseRow } from '../db/repo/charge.js';
import type { PaymentRow } from '../db/repo/payment.js';
import type {
  AllocatedChargeRow,
  ChainBalanceResult,
  LeaseBalanceSliceResult,
  ArrearsChainRow,
  RawLedgerEntry,
} from '../db/repo/ledger.js';
import type { PortalBalanceResult } from '../db/repo/portal/balance.js';
import {
  mapProperty,
  mapUnit,
  mapTenant,
  mapPortalProfile,
  derivePortalAccess,
  mapRentStep,
  mapRentStepCorrection,
  mapPortalRentStep,
  mapCharge,
  mapChargeWithLease,
  mapPortalCharge,
  mapPayment,
  mapPortalPayment,
  mapAllocatedCharge,
  mapLedgerEntry,
  mapLedgerLease,
  mapChainBalance,
  mapLeaseBalanceSlice,
  mapLeaseBalanceResponse,
  mapArrearsRow,
  mapArrearsResponse,
  mapPortalBalance,
} from './mappers.js';

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
  moveOutBillingPolicy: 'bill_full_term',
  calendar: 'gregorian',
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

  it('passes through moveOutBillingPolicy and calendar', () => {
    const mapped = mapProperty({
      ...propertyRow,
      moveOutBillingPolicy: 'stop_at_move_out',
      calendar: 'bikram_sambat',
    });
    expect(mapped.moveOutBillingPolicy).toBe('stop_at_move_out');
    expect(mapped.calendar).toBe('bikram_sambat');
    expect(propertySchema.safeParse(mapped).success).toBe(true);
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

/* ======================================================================== *
 * rent escalation — PLAN-ESCALATION.md §2.3/§2.4. `escalationFromRow` and the
 * three new row-to-contract mappers it feeds and sits alongside.
 * ======================================================================== */

describe('escalationFromRow', () => {
  it("'none' maps to null — the contract never surfaces the no-op enum value", () => {
    expect(
      escalationFromRow({
        escalationMode: 'none',
        escalationRateBps: null,
        escalationIntervalYears: null,
        escalationCompounding: null,
      }),
    ).toBeNull();
  });

  it("'percent' maps to the full clause object", () => {
    expect(
      escalationFromRow({
        escalationMode: 'percent',
        escalationRateBps: 1000,
        escalationIntervalYears: 1,
        escalationCompounding: 'compound',
      }),
    ).toEqual({ mode: 'percent', rateBps: 1000, intervalYears: 1, compounding: 'compound' });
  });
});

const rentStepRow: RentStepRow = {
  id: '0191c2e4-4d5e-7f6a-8b9c-0d1e2f3a4b5c',
  leaseId: '0191c2e4-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
  effectiveFrom: '2027-04-01',
  rentCents: 586600,
  source: 'clause',
  clauseExpectedCents: 586600,
  note: null,
  createdAt: new Date('2026-04-01T00:00:00.000Z'),
  updatedAt: new Date('2026-04-01T00:00:00.000Z'),
};

describe('mapRentStep', () => {
  it('produces a value matching the contract schema', () => {
    expect(rentStepSummary.safeParse(mapRentStep(rentStepRow)).success).toBe(true);
  });

  it('converts a null note to undefined (rentStepInput.note is .optional(), not .nullable())', () => {
    expect(mapRentStep(rentStepRow).note).toBeUndefined();
  });

  it('preserves a present note — landlord-private, but present on the landlord shape', () => {
    const mapped = mapRentStep({ ...rentStepRow, note: 'Good tenant — 5% only' });
    expect(mapped.note).toBe('Good tenant — 5% only');
  });

  it('formats timestamps as ISO strings', () => {
    expect(mapRentStep(rentStepRow).createdAt).toBe('2026-04-01T00:00:00.000Z');
  });

  it('preserves a null clauseExpectedCents (the commercial, hand-entered case)', () => {
    const mapped = mapRentStep({ ...rentStepRow, source: 'manual', clauseExpectedCents: null });
    expect(mapped.clauseExpectedCents).toBeNull();
    expect(rentStepSummary.safeParse(mapped).success).toBe(true);
  });

  it('never leaks leaseId — not part of rentStepSummary', () => {
    const mapped = mapRentStep(rentStepRow) as Record<string, unknown>;
    expect(mapped.leaseId).toBeUndefined();
  });
});

const rentStepCorrectionRow: RentStepCorrectionRow = {
  id: '0191c2e4-6f7a-8b9c-8d1e-2f3a4b5c6d7e',
  leaseId: '0191c2e4-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
  stepId: rentStepRow.id,
  effectiveFrom: '2020-06-01',
  oldRentCents: 110000,
  newRentCents: 105000,
  reason: 'Good tenant, 5% only instead of 10%.',
  correctedByUserId: 'user_1',
  correctedByName: 'Alice Landlord',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
};

describe('mapRentStepCorrection', () => {
  it('produces a value matching the contract schema', () => {
    expect(rentStepCorrection.safeParse(mapRentStepCorrection(rentStepCorrectionRow)).success).toBe(true);
  });

  it('preserves a null correctedByName (a deleted user account must never break rendering an old correction)', () => {
    const mapped = mapRentStepCorrection({ ...rentStepCorrectionRow, correctedByName: null });
    expect(mapped.correctedByName).toBeNull();
    expect(rentStepCorrection.safeParse(mapped).success).toBe(true);
  });

  it('formats createdAt as an ISO string', () => {
    expect(mapRentStepCorrection(rentStepCorrectionRow).createdAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('mapPortalRentStep', () => {
  it('produces ONLY effectiveFrom and rentCents — no note, no source, no clauseExpectedCents', () => {
    const mapped = mapPortalRentStep(rentStepRow) as Record<string, unknown>;
    expect(Object.keys(mapped).sort()).toEqual(['effectiveFrom', 'rentCents']);
    expect(portalRentStep.safeParse(mapped).success).toBe(true);
  });

  it("never leaks the landlord-private note, even when the source row carries one", () => {
    const sourceRow: RentStepRow = { ...rentStepRow, note: 'Good tenant — 5% only' };
    const mapped = mapPortalRentStep(sourceRow) as Record<string, unknown>;
    expect(mapped.note).toBeUndefined();
  });
});

const chargeRow: ChargeRow = {
  id: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  leaseId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e10',
  type: 'rent',
  generationKey: '2026-04-01',
  periodIndex: 3,
  periodStart: '2026-04-01',
  periodEnd: '2026-04-30',
  occupiedStart: '2026-04-17',
  occupiedEnd: '2026-04-30',
  daysOccupied: 14,
  daysInPeriod: 30,
  dueDate: '2026-04-17',
  amountCents: 70000,
  isProrated: true,
  currency: 'USD',
  description: null,
  source: 'generated',
  supersedesChargeId: null,
  voidedAt: null,
  voidedReason: null,
  voidedByUserId: null,
  createdByUserId: null,
  createdAt: new Date('2026-04-01T09:00:00.000Z'),
};

describe('mapCharge', () => {
  it('produces a value matching the contract schema', () => {
    expect(chargeSchema.safeParse(mapCharge(chargeRow)).success).toBe(true);
  });

  it('formats createdAt and voidedAt as ISO strings, never a bare Date', () => {
    const mapped = mapCharge({
      ...chargeRow,
      voidedAt: new Date('2026-04-02T00:00:00.000Z'),
      voidedReason: 'Charged in error.',
    });
    expect(mapped.createdAt).toBe('2026-04-01T09:00:00.000Z');
    expect(mapped.voidedAt).toBe('2026-04-02T00:00:00.000Z');
  });

  it('preserves a null voidedAt as null, never an empty string', () => {
    expect(mapCharge(chargeRow).voidedAt).toBeNull();
  });

  it('never leaks voidedByUserId — structurally absent from the landlord charge shape', () => {
    const mapped = mapCharge({ ...chargeRow, voidedByUserId: 'user_42' }) as Record<string, unknown>;
    expect(mapped.voidedByUserId).toBeUndefined();
  });

  it('round-trips every one of the eleven PlannedCharge-shaped fields unchanged', () => {
    const mapped = mapCharge(chargeRow);
    expect(mapped.generationKey).toBe(chargeRow.generationKey);
    expect(mapped.periodIndex).toBe(chargeRow.periodIndex);
    expect(mapped.periodStart).toBe(chargeRow.periodStart);
    expect(mapped.periodEnd).toBe(chargeRow.periodEnd);
    expect(mapped.occupiedStart).toBe(chargeRow.occupiedStart);
    expect(mapped.occupiedEnd).toBe(chargeRow.occupiedEnd);
    expect(mapped.daysOccupied).toBe(chargeRow.daysOccupied);
    expect(mapped.daysInPeriod).toBe(chargeRow.daysInPeriod);
    expect(mapped.dueDate).toBe(chargeRow.dueDate);
    expect(mapped.amountCents).toBe(chargeRow.amountCents);
    expect(mapped.isProrated).toBe(chargeRow.isProrated);
  });
});

describe('mapChargeWithLease', () => {
  const row: ChargeWithLeaseRow = {
    ...chargeRow,
    propertyId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e20',
    propertyName: 'Maple Court',
    unitId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e30',
    unitLabel: '2B',
    propertyTimezone: 'America/Chicago',
  };

  it('produces a value matching the contract schema', () => {
    expect(chargeWithLeaseSchema.safeParse(mapChargeWithLease(row)).success).toBe(true);
  });

  it('carries every charge field plus the lease context', () => {
    const mapped = mapChargeWithLease(row);
    expect(mapped.id).toBe(row.id);
    expect(mapped.propertyName).toBe('Maple Court');
    expect(mapped.unitLabel).toBe('2B');
    expect(mapped.propertyTimezone).toBe('America/Chicago');
  });
});

describe('mapPortalCharge', () => {
  it('produces a value matching the contract schema', () => {
    expect(portalChargeSchema.safeParse(mapPortalCharge(chargeRow)).success).toBe(true);
  });

  it('collapses voidedAt to a plain isVoided boolean — whether, not when or why', () => {
    const live = mapPortalCharge(chargeRow) as Record<string, unknown>;
    expect(live.isVoided).toBe(false);
    expect(live.voidedAt).toBeUndefined();

    const voided = mapPortalCharge({
      ...chargeRow,
      voidedAt: new Date('2026-04-02T00:00:00.000Z'),
      voidedReason: 'Landlord bookkeeping — unflattering.',
    }) as Record<string, unknown>;
    expect(voided.isVoided).toBe(true);
  });

  it('never leaks voidedReason, source, generationKey, periodIndex, or any user id', () => {
    const mapped = mapPortalCharge({
      ...chargeRow,
      voidedAt: new Date('2026-04-02T00:00:00.000Z'),
      voidedReason: 'Duplicate — my error.',
      createdByUserId: 'user_1',
    }) as Record<string, unknown>;
    expect(mapped.voidedReason).toBeUndefined();
    expect(mapped.source).toBeUndefined();
    expect(mapped.generationKey).toBeUndefined();
    expect(mapped.periodIndex).toBeUndefined();
    expect(mapped.createdByUserId).toBeUndefined();
    expect(mapped.voidedByUserId).toBeUndefined();
  });

  it('keeps the proration fields — the most disputed numbers in renting', () => {
    const mapped = mapPortalCharge(chargeRow);
    expect(mapped.daysOccupied).toBe(14);
    expect(mapped.daysInPeriod).toBe(30);
    expect(mapped.isProrated).toBe(true);
  });

  it('keeps supersedesChargeId — "$1,000 replaced by $900" reads as one correction', () => {
    const mapped = mapPortalCharge({ ...chargeRow, supersedesChargeId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e40' });
    expect(mapped.supersedesChargeId).toBe('0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e40');
  });
});

/* ======================================================================== *
 * payments, the ledger and balances — PLAN-PHASE3B.md
 * ======================================================================== */

const paymentRow: PaymentRow = {
  id: '0191c2e4-3c4d-7e5f-8a6b-7c8d9e0f1a2b',
  leaseId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  kind: 'payment',
  method: 'bank_transfer',
  amountCents: 150000,
  currency: 'USD',
  receivedOn: '2026-04-01',
  reference: 'REF-001',
  note: 'Paid late again — chase in person.',
  supersedesPaymentId: null,
  voidedAt: null,
  voidedReason: null,
  voidedByUserId: null,
  recordedByUserId: 'user_1',
  createdAt: new Date('2026-04-01T00:00:00.000Z'),
  updatedAt: new Date('2026-04-01T00:00:00.000Z'),
};

describe('mapPayment', () => {
  it('produces a value matching the contract schema', () => {
    expect(paymentSchema.safeParse(mapPayment(paymentRow)).success).toBe(true);
  });

  it('never leaks voidedByUserId — structurally absent from the landlord payment shape', () => {
    const withVoidedBy: PaymentRow = { ...paymentRow, voidedByUserId: 'user_42' };
    const mapped = mapPayment(withVoidedBy) as Record<string, unknown>;
    expect(mapped.voidedByUserId).toBeUndefined();
  });

  it('keeps note and reference — the landlord sees both', () => {
    const mapped = mapPayment(paymentRow);
    expect(mapped.note).toBe('Paid late again — chase in person.');
    expect(mapped.reference).toBe('REF-001');
  });

  it('formats voidedAt as an ISO string, preserves null', () => {
    expect(mapPayment(paymentRow).voidedAt).toBeNull();
    const voided = mapPayment({
      ...paymentRow,
      voidedAt: new Date('2026-04-02T00:00:00.000Z'),
      voidedReason: 'Bounced cheque.',
    });
    expect(voided.voidedAt).toBe('2026-04-02T00:00:00.000Z');
  });
});

describe('mapPortalPayment', () => {
  it('produces a value matching the contract schema', () => {
    expect(portalPaymentSchema.safeParse(mapPortalPayment(paymentRow)).success).toBe(true);
  });

  it('never leaks note, voidedReason, or any user id — the landlord\'s private margin', () => {
    const mapped = mapPortalPayment({
      ...paymentRow,
      voidedAt: new Date('2026-04-02T00:00:00.000Z'),
      voidedReason: 'Unflattering reason.',
    }) as Record<string, unknown>;
    expect(mapped.note).toBeUndefined();
    expect(mapped.voidedReason).toBeUndefined();
    expect(mapped.recordedByUserId).toBeUndefined();
    expect(mapped.voidedByUserId).toBeUndefined();
  });

  it('collapses voidedAt to isVoided, keeps reference — the tenant\'s own bank reference', () => {
    const mapped = mapPortalPayment(paymentRow);
    expect(mapped.isVoided).toBe(false);
    expect(mapped.reference).toBe('REF-001');
  });

  it('keeps supersedesPaymentId — "$1,200 replaced by $1,020" reads as one correction', () => {
    const mapped = mapPortalPayment({ ...paymentRow, supersedesPaymentId: '0191c2e4-4d5e-7f6a-9b7c-8d9e0f1a2b3c' });
    expect(mapped.supersedesPaymentId).toBe('0191c2e4-4d5e-7f6a-9b7c-8d9e0f1a2b3c');
  });
});

const allocatedChargeRow: AllocatedChargeRow = {
  ...chargeRow,
  chainId: '0191c2e4-5e6f-7a7b-8c8d-9e0f1a2b3c4d',
  propertyTimezone: 'UTC',
  appliedCents: 50000,
};

describe('mapAllocatedCharge', () => {
  it('produces a value matching the contract schema', () => {
    expect(allocatedChargeSchema.safeParse(mapAllocatedCharge(allocatedChargeRow, '2026-05-01')).success).toBe(true);
  });

  it('derives status via chargeStatusFor — never a stored column', () => {
    const paid = mapAllocatedCharge({ ...allocatedChargeRow, amountCents: 50000, appliedCents: 50000 }, '2026-05-01');
    expect(paid.status).toBe('paid');

    const overdue = mapAllocatedCharge(
      { ...allocatedChargeRow, dueDate: '2020-01-01', amountCents: 50000, appliedCents: 0 },
      '2026-05-01',
    );
    expect(overdue.status).toBe('overdue');

    const voided = mapAllocatedCharge({ ...allocatedChargeRow, voidedAt: new Date(), appliedCents: 0 }, '2026-05-01');
    expect(voided.status).toBe('void');
  });

  it('a zero-amount charge is born paid, never overdue — the §3.5 trap', () => {
    const mapped = mapAllocatedCharge(
      { ...allocatedChargeRow, dueDate: '2020-01-01', amountCents: 0, appliedCents: 0 },
      '2026-05-01',
    );
    expect(mapped.status).toBe('paid');
  });

  it('never leaks chainId or propertyTimezone — both are internal-only', () => {
    const mapped = mapAllocatedCharge(allocatedChargeRow, '2026-05-01') as Record<string, unknown>;
    expect(mapped.chainId).toBeUndefined();
    expect(mapped.propertyTimezone).toBeUndefined();
  });
});

describe('mapLedgerEntry', () => {
  it('a charge entry matches the discriminated union, charge half', () => {
    const entry: RawLedgerEntry = {
      kind: 'charge',
      leaseId: allocatedChargeRow.leaseId,
      effectiveDate: '2026-04-01',
      runningBalanceCents: 50000,
      charge: allocatedChargeRow,
    };
    const mapped = mapLedgerEntry(entry, '2026-05-01');
    expect(mapped.kind).toBe('charge');
    if (mapped.kind === 'charge') {
      expect(mapped.charge.appliedCents).toBe(50000);
      expect(mapped.runningBalanceCents).toBe(50000);
    }
  });

  it('a payment entry matches the discriminated union, payment half', () => {
    const entry: RawLedgerEntry = {
      kind: 'payment',
      leaseId: paymentRow.leaseId,
      effectiveDate: '2026-04-01',
      runningBalanceCents: -50000,
      payment: paymentRow,
    };
    const mapped = mapLedgerEntry(entry, '2026-05-01');
    expect(mapped.kind).toBe('payment');
    if (mapped.kind === 'payment') {
      expect(mapped.payment.id).toBe(paymentRow.id);
      expect(mapped.runningBalanceCents).toBe(-50000);
    }
  });
});

describe('mapLedgerLease', () => {
  it('passes the four fields through unchanged', () => {
    const mapped = mapLedgerLease({
      leaseId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
      startDate: '2026-01-01',
      endDate: null,
      isCurrent: true,
    });
    expect(mapped).toEqual({
      leaseId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
      startDate: '2026-01-01',
      endDate: null,
      isCurrent: true,
    });
  });
});

const chainBalanceResult: ChainBalanceResult = {
  chainId: '0191c2e4-5e6f-7a7b-8c8d-9e0f1a2b3c4d',
  currency: 'USD',
  asOfDate: '2026-05-01',
  chargedCents: 100000,
  paidCents: 150000,
  outstandingCents: 0,
  creditCents: 50000,
  balanceCents: -50000,
  arrearsCents: 0,
  depositOutstandingCents: 0,
  rentOutstandingCents: 0,
  oldestOverdueDueDate: null,
};

describe('mapChainBalance', () => {
  it('produces a value matching the contract schema — a signed balanceCents, never money', () => {
    expect(chainBalanceSchema.safeParse(mapChainBalance(chainBalanceResult)).success).toBe(true);
  });

  it('carries the signed balance through — a credit is negative, not clamped', () => {
    expect(mapChainBalance(chainBalanceResult).balanceCents).toBe(-50000);
  });
});

describe('mapLeaseBalanceSlice / mapLeaseBalanceResponse', () => {
  const sliceResult: LeaseBalanceSliceResult = {
    leaseId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
    outstandingCents: 20000,
    arrearsCents: 20000,
    depositOutstandingCents: 0,
    rentOutstandingCents: 20000,
  };

  it('mapLeaseBalanceSlice produces a value matching the contract schema, with no creditCents field', () => {
    const mapped = mapLeaseBalanceSlice(sliceResult) as Record<string, unknown>;
    expect(leaseBalanceSliceSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.creditCents).toBeUndefined();
    expect(mapped.balanceCents).toBeUndefined();
  });

  it('mapLeaseBalanceResponse combines both slices in one response', () => {
    const mapped = mapLeaseBalanceResponse({ lease: sliceResult, chain: chainBalanceResult });
    expect(leaseBalanceResponseSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.lease.leaseId).toBe(sliceResult.leaseId);
    expect(mapped.chain.chainId).toBe(chainBalanceResult.chainId);
  });
});

const arrearsChainRow: ArrearsChainRow = {
  chainId: '0191c2e4-5e6f-7a7b-8c8d-9e0f1a2b3c4d',
  leaseId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  currency: 'USD',
  propertyId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e20',
  propertyName: 'Maple Court',
  unitId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e30',
  unitLabel: '2B',
  primaryTenantName: 'Dana Lee',
  arrearsCents: 50000,
  oldestOverdueDueDate: '2026-03-01',
  daysLate: 40,
  isCurrent: true,
};

describe('mapArrearsRow', () => {
  it('produces a value matching the contract schema', () => {
    expect(arrearsRowSchema.safeParse(mapArrearsRow(arrearsChainRow)).success).toBe(true);
  });
});

describe('mapArrearsResponse', () => {
  it('groups by currency at the top level — no array ever contains two currencies', () => {
    const usdRow = arrearsChainRow;
    const gbpRow: ArrearsChainRow = { ...arrearsChainRow, chainId: '0191c2e4-6f7a-7b8c-9d9e-0f1a2b3c4d5e', currency: 'GBP', arrearsCents: 10000 };

    const mapped = mapArrearsResponse([usdRow, gbpRow], false, '2026-05-01');
    expect(arrearsResponseSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.groups).toHaveLength(2);
    const usdGroup = mapped.groups.find((g) => g.currency === 'USD')!;
    expect(usdGroup.chainCount).toBe(1);
    expect(usdGroup.totalArrearsCents).toBe(50000);
    const gbpGroup = mapped.groups.find((g) => g.currency === 'GBP')!;
    expect(gbpGroup.totalArrearsCents).toBe(10000);
  });

  it('sums totalArrearsCents and counts chains within one currency group', () => {
    const second: ArrearsChainRow = { ...arrearsChainRow, chainId: '0191c2e4-7a8b-7c9d-9e0f-1a2b3c4d5e6f', arrearsCents: 25000 };
    const mapped = mapArrearsResponse([arrearsChainRow, second], false, '2026-05-01');
    expect(mapped.groups).toHaveLength(1);
    expect(mapped.groups[0]!.chainCount).toBe(2);
    expect(mapped.groups[0]!.totalArrearsCents).toBe(75000);
  });

  it('an empty input is a real, valid state — no groups, never an error', () => {
    const mapped = mapArrearsResponse([], false, '2026-05-01');
    expect(arrearsResponseSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.groups).toEqual([]);
  });

  it('carries the truncated flag through unchanged', () => {
    expect(mapArrearsResponse([], true, '2026-05-01').truncated).toBe(true);
  });
});

describe('mapPortalBalance', () => {
  const portalBalanceResult: PortalBalanceResult = {
    leaseId: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
    currency: 'USD',
    asOfDate: '2026-05-01',
    outstandingCents: 0,
    overdueCents: 0,
    depositOutstandingCents: 0,
    creditCents: 50000,
    nextDueDate: null,
    nextDueAmountCents: 0,
  };

  it('produces a value matching the contract schema — no signed balanceCents field at all', () => {
    const mapped = mapPortalBalance(portalBalanceResult) as Record<string, unknown>;
    expect(portalBalanceSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.balanceCents).toBeUndefined();
  });
});
