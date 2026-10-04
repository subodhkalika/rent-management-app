import {
  pgTable, text, timestamp, uuid, integer, bigint, real,
  boolean, index, uniqueIndex, pgEnum,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------ *
 * Auth tables — owned by Better Auth's schema generator.
 * `organization` is the tenant boundary: one landlord account.
 * ------------------------------------------------------------------ */

export const user = pgTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const organization = pgTable('organization', {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const member = pgTable(
  'member',
  {
    id: text().primaryKey(),
    organizationId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    userId: text().notNull().references(() => user.id, { onDelete: 'cascade' }),
    role: text().notNull().default('member'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('member_org_user_uq').on(t.organizationId, t.userId),
    index('member_user_idx').on(t.userId),
  ],
);

/* ------------------------------------------------------------------ *
 * Domain tables.
 *
 * Every table below carries orgId. It is NOT NULL, it is the first column of every
 * lookup index, and it must appear in the WHERE clause of every read, update and
 * delete. See docs/ARCHITECTURE.md section 5.
 * ------------------------------------------------------------------ */

export const propertyTypeEnum = pgEnum('property_type', [
  'single_family', 'multi_family', 'apartment', 'condo', 'townhouse', 'commercial',
]);

export const unitStatusEnum = pgEnum('unit_status', ['vacant', 'occupied', 'unavailable']);

export const property = pgTable(
  'property',
  {
    id: uuid().primaryKey(),
    orgId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),

    name: text().notNull(),
    type: propertyTypeEnum().notNull(),

    addressLine1: text().notNull(),
    addressLine2: text(),
    city: text().notNull(),
    region: text().notNull(),
    postalCode: text().notNull(),
    country: text().notNull(),

    notes: text(),

    // Soft delete: payments and leases reference properties, and financial history
    // must survive a landlord removing a property from their active list.
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('property_org_idx').on(t.orgId, t.deletedAt)],
);

export const unit = pgTable(
  'unit',
  {
    id: uuid().primaryKey(),
    orgId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    propertyId: uuid().notNull().references(() => property.id, { onDelete: 'cascade' }),

    label: text().notNull(),
    bedrooms: integer().notNull().default(0),
    // real, not integer: half-baths are universal (1.5 bath).
    bathrooms: real().notNull().default(0),
    squareFeet: integer(),

    // Money is integer minor units in a bigint. mode:'number' is safe here because
    // the values are cents well inside Number.MAX_SAFE_INTEGER.
    marketRentCents: bigint({ mode: 'number' }).notNull().default(0),
    currency: text().notNull().default('USD'),

    status: unitStatusEnum().notNull().default('vacant'),
    notes: text(),

    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('unit_org_property_idx').on(t.orgId, t.propertyId, t.deletedAt),
    // A door number is unique within its property. Scoped by org too, so two
    // landlords can never collide even in the impossible case of a shared propertyId.
    uniqueIndex('unit_label_uq').on(t.orgId, t.propertyId, t.label),
  ],
);
