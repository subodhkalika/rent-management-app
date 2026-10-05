import { sql } from 'drizzle-orm';
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

// `session` is Better Auth core + the `activeOrganizationId` column the
// `organization` plugin adds to it. `requireAuth` (middleware/auth.ts) reads
// `session.session.activeOrganizationId` — without this column every sign-in
// would 500 instead of just lacking an active org.
export const session = pgTable(
  'session',
  {
    id: text().primaryKey(),
    userId: text().notNull().references(() => user.id, { onDelete: 'cascade' }),
    token: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    activeOrganizationId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

// One row per sign-in method linked to a user. `email_password` stores the hash in
// `password`; OAuth providers would store tokens here instead (not configured yet).
export const account = pgTable(
  'account',
  {
    id: text().primaryKey(),
    userId: text().notNull().references(() => user.id, { onDelete: 'cascade' }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

// Email verification / password reset / magic-link tokens. Better Auth creates and
// consumes these itself; the API never reads this table directly.
export const verification = pgTable(
  'verification',
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

// Pending org invites, created by the `organization` plugin's invite endpoints.
export const invitation = pgTable(
  'invitation',
  {
    id: text().primaryKey(),
    organizationId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: text(),
    status: text().notNull().default('pending'),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    inviterId: text().notNull().references(() => user.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invitation_org_idx').on(t.organizationId),
    index('invitation_email_idx').on(t.email),
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

// Whether an early move-out stops rent. Mirrors `moveOutBillingPolicy` in
// packages/contract/src/billing.ts. `bill_full_term` is the default because it is
// the behaviour every existing property already has — this migration is a semantic
// no-op until a landlord deliberately changes it.
export const moveOutBillingPolicyEnum = pgEnum('move_out_billing_policy', [
  'bill_full_term', 'stop_at_move_out',
]);

// Which calendar defines this property's billing periods. Mirrors `calendarSystem`
// in packages/contract/src/calendar/index.ts. Dates are always stored as Gregorian
// ISO regardless (docs/DATES.md) — this decides where PERIODS begin and end, not the
// storage format. 'gregorian' is the default for the same no-op-migration reason.
export const calendarSystemEnum = pgEnum('calendar_system', ['gregorian', 'bikram_sambat']);

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

    // IANA zone, e.g. "Australia/Perth". Drives "what is today" for arrears and
    // reminders (docs/PLAN-V1.md §4.4) — never stored elsewhere. Safe single-step
    // migration (`NOT NULL DEFAULT`), but 'UTC' is the wrong answer for a real
    // non-UTC landlord; see docs/PLAN-V1.md §2.3. `createPropertyBody` now requires
    // this field and `updatePropertyBody` accepts it (docs/TASKS/005), so every
    // property created from here on gets a real value; existing rows keep 'UTC'
    // until the landlord is prompted to fix them.
    timezone: text().notNull().default('UTC'),

    // Both NOT NULL DEFAULT, same no-op-migration reasoning as `timezone` above —
    // see docs/TASKS/006-calendar-seam.md and docs/DATES.md. `billing_day`'s 1..31
    // CHECK (none currently enforced at the DB layer) is Gregorian-only; widening it
    // for 'bikram_sambat' properties is `Calendar.maxDayOfMonth` / `MAX_BILLING_DAY`
    // in packages/contract, not a column constraint here.
    moveOutBillingPolicy: moveOutBillingPolicyEnum().notNull().default('bill_full_term'),
    calendar: calendarSystemEnum().notNull().default('gregorian'),

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

/* ------------------------------------------------------------------ *
 * Tenant and the two-actor permission spine (docs/PLAN-V1.md §1, §2.2).
 *
 * A tenant user is NOT an organization member — `requireAuth` authorizes on nothing
 * but the presence of a `member` row, so a tenant holding one would reach every
 * landlord route. The link to a login is `tenant.userId`, nullable, pointing at
 * Better Auth's `user` table. One `user` may be pointed at by many `tenant` rows
 * across many orgs (the multi-landlord-tenant case) — a plain many-to-one, no join
 * table needed for the link itself.
 * ------------------------------------------------------------------ */

export const tenantStatusEnum = pgEnum('tenant_status', ['prospect', 'active', 'past', 'archived']);

export const tenant = pgTable(
  'tenant',
  {
    id: uuid().primaryKey(),
    orgId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    // The portal link. NULL = no portal access. `onDelete: 'set null'` rather than
    // cascade: deleting a Better Auth user must not take the landlord's tenant
    // record (and its financial history, once leases exist) with it.
    userId: text().references(() => user.id, { onDelete: 'set null' }),

    firstName: text().notNull(),
    lastName: text().notNull(),
    // Nullable: a cash-only tenant with no portal account can still exist. Required
    // before `POST /v1/tenants/:id/invite` will issue an invite.
    email: text(),
    phone: text(),
    emergencyContactName: text(),
    emergencyContactPhone: text(),

    status: tenantStatusEnum().notNull().default('prospect'),
    remindersOptedOut: boolean().notNull().default(false),

    // Landlord-private. MUST appear in no portal response — see
    // db/repo/portal/profile.ts and portal.ts in the contract, which has no field
    // for it at all (not "hidden", structurally absent).
    notes: text(),

    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tenant_org_idx').on(t.orgId, t.deletedAt),
    // The hot path for `requireTenant`: every authenticated request from a tenant
    // resolves their scope by `userId` alone, across every org.
    index('tenant_user_idx').on(t.userId).where(sql`${t.userId} is not null`),
    // One portal identity per org per user — stops a landlord from somehow
    // double-binding one login to two tenant rows in their own org.
    uniqueIndex('tenant_org_user_uq').on(t.orgId, t.userId).where(sql`${t.userId} is not null`),
    uniqueIndex('tenant_org_email_uq')
      .on(t.orgId, sql`lower(${t.email})`)
      .where(sql`${t.email} is not null and ${t.deletedAt} is null`),
  ],
);

/** Single-use portal invite. Looked up by `tokenHash` alone — see
 *  `db/repo/public/invite.ts` for why that lookup deliberately lives outside the
 *  ordinary `orgId`-first repo convention. */
export const tenantInvite = pgTable(
  'tenant_invite',
  {
    id: uuid().primaryKey(),
    orgId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    tenantId: uuid().notNull().references(() => tenant.id, { onDelete: 'cascade' }),

    // Snapshot at issue time. The account created on accept uses THIS value, never
    // one from the request body — see docs/PLAN-V1.md §1.3.
    email: text().notNull(),
    // Hex SHA-256 of a 32-byte random token. The raw token is never stored anywhere.
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),

    acceptedAt: timestamp({ withTimezone: true }),
    acceptedUserId: text().references(() => user.id),
    revokedAt: timestamp({ withTimezone: true }),

    createdByUserId: text().notNull().references(() => user.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The ONLY lookup path for accept. A plain unique index, not partial: a used or
    // expired token's hash must still 404, never be reusable just because a newer
    // row happens to collide (SHA-256 collision is not a threat model worth a
    // partial-uniqueness escape hatch for).
    uniqueIndex('tenant_invite_token_uq').on(t.tokenHash),
    index('tenant_invite_tenant_idx').on(t.orgId, t.tenantId),
  ],
);
