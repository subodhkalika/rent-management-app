import type { Property, Unit } from '@rms/contract';
import type { PropertyRow } from '../db/repo/property.js';
import type { UnitRow } from '../db/repo/unit.js';

/**
 * Explicit DB row -> contract type mapping. Never spread a row into a response —
 * an internal column (e.g. a future `orgId` or `deletedAt`) must not leak just
 * because someone added it to the table.
 */
export function mapProperty(row: PropertyRow): Property {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    address: {
      line1: row.addressLine1,
      line2: row.addressLine2 ?? undefined,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      country: row.country,
    },
    notes: row.notes,
    unitCount: row.unitCount,
    occupiedUnitCount: row.occupiedUnitCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapUnit(row: UnitRow): Unit {
  return {
    id: row.id,
    propertyId: row.propertyId,
    label: row.label,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    squareFeet: row.squareFeet,
    marketRentCents: row.marketRentCents,
    currency: row.currency as Unit['currency'],
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
