import { describe, it, expect } from 'vitest';
import { property as propertySchema, unit as unitSchema } from '@rms/contract';
import type { PropertyRow } from '../db/repo/property.js';
import type { UnitRow } from '../db/repo/unit.js';
import { mapProperty, mapUnit } from './mappers.js';

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
