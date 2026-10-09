import { sql } from 'drizzle-orm';
import {
  pgTable, text, timestamp, uuid, integer, bigint, real, date, smallint,
  boolean, jsonb, index, uniqueIndex, pgEnum, check, type AnyPgColumn,
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

/* ------------------------------------------------------------------ *
 * Lease — docs/PLAN-PHASE2.md §3. Unit + tenant(s), date range, rent,
 * deposit, status. `move_out_billing_policy` and `calendar` are NOT columns
 * here — they are resolved LIVE from `property` on every read (Amendment A.3
 * / docs/DATES.md), so a settings flip takes effect on the next read with no
 * backfill and no per-lease override ever possible.
 * ------------------------------------------------------------------ */

export const leaseStatusEnum = pgEnum('lease_status', [
  'draft', 'active', 'ended', 'terminated', 'cancelled',
]);

export const rentFrequencyEnum = pgEnum('rent_frequency', ['monthly', 'yearly']);

/* ------------------------------------------------------------------ *
 * Rent escalation — docs/PLAN-ESCALATION.md revision 2. The clause (four
 * columns on `lease`, below) is a PROPOSAL that drafts `lease_rent_step` rows;
 * the stored steps are the truth the schedule reads, never the clause itself.
 * See `packages/contract/src/billing.ts`'s own header comment for the full
 * reasoning — `rentForPeriodStart` is a pure lookup over the steps, never
 * arithmetic on the clause.
 * ------------------------------------------------------------------ */

// 'none' exists so `escalation_mode` is NOT NULL with a default (a no-op
// migration for every existing lease) — the CONTRACT never surfaces 'none' on
// a response, it maps the column to `escalation: null`. Mirrors
// `rentEscalationMode` in packages/contract/src/billing.ts.
export const rentEscalationModeEnum = pgEnum('rent_escalation_mode', ['none', 'percent']);
export const rentEscalationCompoundingEnum = pgEnum('rent_escalation_compounding', ['compound', 'simple']);
// 'clause' = the generator drafted this step and nobody has touched it;
// 'manual' = a human set this figure, by hand or by overriding a draft.
export const rentStepSourceEnum = pgEnum('rent_step_source', ['clause', 'manual']);

export const lease = pgTable(
  'lease',
  {
    id: uuid().primaryKey(),
    orgId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    // Restrict, not cascade: units are soft-deleted, so a cascade here would be a
    // latent data-loss path for financial history (PLAN-PHASE2.md §3.2).
    unitId: uuid().notNull().references(() => unit.id, { onDelete: 'restrict' }),

    // = id for a fresh lease, = predecessor.chainId on renewal. Phase 3 balances
    // aggregate on this.
    chainId: uuid().notNull(),
    renewedFromLeaseId: uuid().references((): AnyPgColumn => lease.id, { onDelete: 'set null' }),

    startDate: date().notNull(),
    // NULL = rolling. Inclusive. The only thing that clips the schedule under
    // `bill_full_term` (see billing.ts's `effectiveBillingEnd`).
    endDate: date(),
    // Actual hand-back. Affects billing only under the property's
    // `stop_at_move_out` policy, and then only by SHORTENING (Amendment A).
    moveOutDate: date(),

    rentCents: bigint({ mode: 'number' }).notNull(),
    // Copied from the unit at create. Immutable. Not in createLeaseBody.
    currency: text().notNull(),
    rentFrequency: rentFrequencyEnum().notNull().default('monthly'),
    // 1..32 — the 32 ceiling is Bikram Sambat's (packages/contract's
    // MAX_BILLING_DAY_ANY / Calendar.maxDayOfMonth); 31 is Gregorian's own
    // ceiling. The CHECK below only enforces the wider, calendar-agnostic bound —
    // the per-calendar bound is enforced by `validateBillingTerms` in the contract,
    // called against the lease's resolved property.calendar.
    billingDay: smallint().notNull().default(1),
    depositCents: bigint({ mode: 'number' }).notNull().default(0),
    // Written in Phase 2, materialised as a charge by Phase 3. Non-negative: a
    // prepaid tenant is a Phase 3 payment, not a negative opening balance.
    openingBalanceCents: bigint({ mode: 'number' }).notNull().default(0),
    // Must equal startDate or be a period start (validateBillingTerms).
    ledgerStartDate: date().notNull(),

    status: leaseStatusEnum().notNull().default('draft'),
    endReason: text(),
    endNote: text(),
    // Landlord-private. Structurally absent from every portal shape.
    notes: text(),

    // The escalation CLAUSE — documentation only (PLAN-ESCALATION.md decision 15).
    // It moves no money on its own; `lease_rent_step` below is what the schedule
    // reads. `escalation_mode = 'none'` is the no-op-migration default; the three
    // columns beneath it are NULL iff mode is 'none', enforced by
    // `lease_escalation_ck` below so a half-written clause is unrepresentable.
    escalationMode: rentEscalationModeEnum().notNull().default('none'),
    // Basis points — 1000 = 10%. Range (1..5000) enforced by lease_escalation_ck.
    escalationRateBps: integer(),
    // Years between increases — 1..10 in practice, range enforced by the CHECK.
    // Independent of rent_frequency: monthly-billed + annually-escalating is the
    // dominant real case.
    escalationIntervalYears: smallint(),
    escalationCompounding: rentEscalationCompoundingEnum(),
    // Tracking only — the clause edits through the ordinary PATCH route, on any
    // status but cancelled (R1's dedicated correct-escalation route is CUT; see
    // PLAN-ESCALATION.md §4.1). Both NULL until the clause is first set or edited.
    escalationUpdatedAt: timestamp({ withTimezone: true }),
    escalationUpdatedByUserId: text().references(() => user.id),

    // Soft delete, same convention as property/unit/tenant — never set outside
    // `draft`/`cancelled` (enforced by hardDeleteLease's WHERE, not by a CHECK:
    // a CHECK can't reference the value a row had before THIS update). Named
    // `hardDeleteLease` in the repo (docs/PLAN-PHASE2.md §8.1) to mark it as a
    // stronger, terminal operation than a lifecycle status transition — not a
    // literal SQL DELETE, for the same "financial history never truly
    // disappears" reasoning as every other soft-deleted table in this schema.
    deletedAt: timestamp({ withTimezone: true }),
    createdByUserId: text().notNull().references(() => user.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('lease_org_unit_idx').on(t.orgId, t.unitId, t.status),
    index('lease_chain_idx').on(t.orgId, t.chainId),
    index('lease_org_status_start_idx').on(t.orgId, t.status, t.startDate),

    // THE MOST VALUABLE CONSTRAINT IN THE SCHEMA (docs/PLAN-PHASE2.md §3.3).
    // Deliberately NO org_id in this index. unit_id is already the PK of a table
    // that itself carries org_id, so adding org_id here would WIDEN the key
    // without changing uniqueness — the one-column form is STRICTER, not a
    // tenancy miss. Landlord B can only ever reach this index through a lease row
    // B owns, so B can never learn whether A's unit is occupied (§3.3's last
    // bullet) — it is not a lateral-movement primitive.
    //
    // No `deletedAt IS NULL` either: an `active` lease is never soft-deleted
    // (deletedAt is reachable only from draft/cancelled).
    //
    // The explicit `::lease_status` cast exists because Postgres can reject an
    // untyped string literal in an index predicate — verify this against the
    // generated migration before committing it (§3.5).
    uniqueIndex('lease_unit_active_uq').on(t.unitId).where(sql`${t.status} = 'active'::lease_status`),

    check('lease_dates_ck', sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
    check(
      'lease_ledger_ck',
      sql`${t.ledgerStartDate} >= ${t.startDate} and (${t.endDate} is null or ${t.ledgerStartDate} <= ${t.endDate})`,
    ),
    check('lease_billing_day_ck', sql`${t.billingDay} between 1 and 32`),
    check(
      'lease_money_ck',
      sql`${t.rentCents} >= 0 and ${t.depositCents} >= 0 and ${t.openingBalanceCents} >= 0`,
    ),
    // Amendment A: holdover is legal (move-out AFTER start), early exit is legal
    // (move-out between start and end) — nothing ties this to end_date.
    check('lease_moveout_ck', sql`${t.moveOutDate} is null or ${t.moveOutDate} >= ${t.startDate}`),

    // One all-or-nothing CHECK so a half-written clause — a rate with no interval,
    // an interval with no compounding — is unrepresentable (PLAN-ESCALATION.md
    // §2.2). 5000 / 10 mirror the contract's MAX_ESCALATION_RATE_BPS /
    // MAX_ESCALATION_INTERVAL_YEARS (packages/contract/src/billing.ts) — duplicated
    // here as literals because a DB CHECK cannot import a TS constant; keep them in
    // sync by hand if either ever changes.
    check(
      'lease_escalation_ck',
      sql`(${t.escalationMode} = 'none' and ${t.escalationRateBps} is null and ${t.escalationIntervalYears} is null and ${t.escalationCompounding} is null)
          or
          (${t.escalationMode} = 'percent' and ${t.escalationRateBps} between 1 and 5000 and ${t.escalationIntervalYears} between 1 and 10 and ${t.escalationCompounding} is not null)`,
    ),
  ],
);

export const leaseTenant = pgTable(
  'lease_tenant',
  {
    id: uuid().primaryKey(),
    orgId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    // Cascade: only ever runs on the hard-delete of a draft/cancelled lease, which
    // by precondition (lease_unit_active_uq, the lifecycle) never had charges or
    // payments written against it.
    leaseId: uuid().notNull().references(() => lease.id, { onDelete: 'cascade' }),
    // Restrict: tenants are only ever soft-deleted.
    tenantId: uuid().notNull().references(() => tenant.id, { onDelete: 'restrict' }),

    isPrimary: boolean().notNull().default(false),
    addedOn: date().notNull(),
    // Roommate swap. NULL = still on the lease.
    removedOn: date(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('lease_tenant_ck', sql`${t.removedOn} is null or ${t.removedOn} >= ${t.addedOn}`),

    index('lease_tenant_lease_idx').on(t.orgId, t.leaseId),
    // The portal's driving scan: every tenant-facing lease query starts here.
    index('lease_tenant_tenant_idx').on(t.orgId, t.tenantId),

    // Partial on removedOn IS NULL, not a plain (lease_id, tenant_id) unique —
    // the full version would block a roommate who leaves and comes back, which
    // is exactly the history this table exists to record (PLAN-PHASE2.md §3.4
    // [CORRECTION] 1).
    uniqueIndex('lease_tenant_live_uq').on(t.leaseId, t.tenantId).where(sql`${t.removedOn} is null`),
    // At-most-one primary per lease, enforced by the database. At-least-one
    // stays an `activate` precondition — no index can express that half
    // (PLAN-PHASE2.md §3.4 [CORRECTION] 2).
    uniqueIndex('lease_tenant_primary_uq')
      .on(t.leaseId)
      .where(sql`${t.isPrimary} and ${t.removedOn} is null`),
  ],
);

/* ------------------------------------------------------------------ *
 * lease_rent_step — the stored ladder the schedule actually reads
 * (PLAN-ESCALATION.md §2.3). The clause on `lease` only ever drafts these rows;
 * once written, a step is the truth until a landlord edits or corrects it.
 * ------------------------------------------------------------------ */

export const leaseRentStep = pgTable(
  'lease_rent_step',
  {
    id: uuid().primaryKey(),
    orgId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    // Cascade: only ever runs on the hard-delete of a draft/cancelled lease, same
    // reasoning as lease_tenant's own cascade above — a lease in that state never
    // had a charge written against its steps.
    leaseId: uuid().notNull().references(() => lease.id, { onDelete: 'cascade' }),
    // A billing-period start, strictly AFTER lease.start_date. Both halves of that
    // rule are CROSS-ROW (this column vs. another table's column) and a period
    // start depends on the lease's cadence/calendar, so NEITHER half can be a
    // CHECK constraint here. Enforced in the repo write path
    // (replaceRentSteps/createLease, via the contract's validateBillingTerms) and
    // covered by a route test — see PLAN-ESCALATION.md §2.3. An unenforceable
    // -looking rule with no comment invites a future reader to assume it is
    // already covered and delete the repo-side check; it is not, so do not.
    effectiveFrom: date().notNull(),
    // The rent from this date until the next step (or forever, if it is the last).
    rentCents: bigint({ mode: 'number' }).notNull(),
    source: rentStepSourceEnum().notNull(),
    // What the clause ALONE would have said at this step. Display only — drives
    // the "agreed X, you set Y" line. NULL when there was no clause, or the step
    // was never clause-drafted.
    clauseExpectedCents: bigint({ mode: 'number' }),
    // Landlord-private, e.g. "good tenant — 5% only". Structurally absent from
    // every portal shape (see portalRentStep in packages/contract/src/portal.ts).
    note: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('lease_rent_step_money_ck', sql`${t.rentCents} >= 0`),

    // Makes "two rents on the same day" unrepresentable. Deliberately NO org_id in
    // this index — lease_id is already the PK of an org-scoped table (`lease`), so
    // adding org_id would WIDEN the key without changing uniqueness. Same
    // reasoning as `lease_unit_active_uq` (schema.ts, above) and PLAN-PHASE2.md
    // §3.3 — flagged here so a reviewer does not read the missing org_id as a
    // tenancy miss.
    uniqueIndex('lease_rent_step_uq').on(t.leaseId, t.effectiveFrom),
    index('lease_rent_step_idx').on(t.orgId, t.leaseId, t.effectiveFrom),
  ],
);

/* ------------------------------------------------------------------ *
 * lease_rent_step_correction — append-only money audit (PLAN-ESCALATION.md
 * §2.4). Written ONLY when a step that had ALREADY TAKEN EFFECT is changed —
 * editing a future step via PUT writes nothing here, because nothing has been
 * billed and nothing is owed. R1's clause-level audit table is CUT: the clause
 * moves no money by itself, so there is nothing to audit until a step changes.
 * ------------------------------------------------------------------ */

export const leaseRentStepCorrection = pgTable(
  'lease_rent_step_correction',
  {
    id: uuid().primaryKey(),
    orgId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    // Restrict, not cascade: a correction is a permanent financial record and must
    // outlive the ordinary lease lifecycle (a corrected step only ever exists on a
    // lease that has already been billed, so the lease itself is never hard
    // -deleted afterwards — hardDeleteLease only runs on draft/cancelled).
    leaseId: uuid().notNull().references(() => lease.id, { onDelete: 'restrict' }),
    stepId: uuid().notNull().references(() => leaseRentStep.id, { onDelete: 'restrict' }),
    // Copied from the step at correction time, so the row reads standalone.
    effectiveFrom: date().notNull(),
    oldRentCents: bigint({ mode: 'number' }).notNull(),
    newRentCents: bigint({ mode: 'number' }).notNull(),
    // 10..500 chars, enforced by the contract's correctRentStepBody.
    reason: text().notNull(),
    correctedByUserId: text().notNull().references(() => user.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lease_rent_step_correction_idx').on(t.orgId, t.leaseId, t.createdAt)],
);

/* ------------------------------------------------------------------ *
 * charge — docs/PLAN-PHASE3A.md §1. A money DOCUMENT, not a derivation.
 *
 * Once written, a row is never updated and never deleted by any code path. The
 * generator's only verb is INSERT ... ON CONFLICT DO NOTHING (charge_generation_uq,
 * below) — "may this period be generated?" is always "is there a row?", never
 * "is this already due?". The ONLY mutation this table ever accepts is the void
 * tombstone (voided_at/voided_reason/voided_by_user_id), set once, by an explicit
 * landlord action carrying a reason. A correction is a SUPERSEDING ROW
 * (supersedes_charge_id), never an edit — see charge_generation_uq's own comment
 * for why a correction carries generation_key = NULL.
 *
 * Stores the WHOLE of PlannedCharge (packages/contract/src/billing.ts), not a
 * subset — a row that explains its own number is what a landlord needs when a
 * tenant argues about proration, and the byte-identity test (PLAN-PHASE3A.md §2)
 * is then a projection, not a re-derivation.
 *
 * Deliberately NOT denormalised: chain_id, unit_id, property_id. Every charge query
 * already joins `lease` for currency/status, and at tens of units a join is free.
 * ------------------------------------------------------------------ */

export const chargeTypeEnum = pgEnum('charge_type', [
  'rent', 'deposit', 'opening_balance', 'late_fee', 'utility', 'other',
]);
// 'generated' = the scheduler wrote it; 'manual' = a person did (including a
// correction, which is always manual — see charge_generation_uq's comment).
export const chargeSourceEnum = pgEnum('charge_source', ['generated', 'manual']);

export const charge = pgTable(
  'charge',
  {
    id: uuid().primaryKey(),
    // CASCADE, same as every other org-owned table — and the ONE sanctioned
    // exception to "a charge is never deleted" (this table's own header comment).
    // Better Auth exposes `deleteOrganization` to an org owner, which is a
    // reachable path that removes every row under that org, charges included,
    // with no void tombstone. That is consistent with the rest of this schema
    // (deleting the landlord's account deletes the landlord's data) and is
    // treated as sanctioned, not a gap — named here so the next reader does not
    // have to rediscover it.
    orgId: text().notNull().references(() => organization.id, { onDelete: 'cascade' }),
    // Restrict, not cascade: a charge is a permanent financial record and must
    // outlive any lease-deletion path (same reasoning as lease_rent_step_correction
    // above). This is also what turns a mistaken hardDeleteLease into a 23503
    // constraint error rather than silently losing billing history — the repo layer
    // pre-checks this explicitly anyway (see repo/lease.ts's hardDeleteLease), since
    // an invariant defended in only one place is one refactor from being defended in
    // none.
    leaseId: uuid().notNull().references(() => lease.id, { onDelete: 'restrict' }),
    type: chargeTypeEnum().notNull(),

    // The eleven PlannedCharge fields, stored whole. NULL for deposit/opening_balance
    // and every manual non-periodic charge.
    periodStart: date(),
    periodEnd: date(),
    // Anchored to the lease's first natural period, NOT an array index — pins
    // fixture F9's periodIndex of 9 for an onboarded, already-in-flight tenancy.
    periodIndex: integer(),
    occupiedStart: date(),
    occupiedEnd: date(),
    daysOccupied: integer(),
    daysInPeriod: integer(),

    // Already clamped by dueDateFor — never day 31 in February.
    dueDate: date().notNull(),
    // CHECK >= 0, NOT > 0 (PLAN-PHASE3A.md §1.5): a prorated rent can legitimately
    // round to zero, and lib/db-errors.ts only recognises 23505 — a 23514 here would
    // surface as an unhandled 500 on the 09:00 UTC cron instead of simply writing a
    // zero-amount row for a period that genuinely exists.
    amountCents: bigint({ mode: 'number' }).notNull(),
    // Copied from lease.currency at write time. Immutable — a charge's currency
    // never changes after the fact, even if the lease's somehow could.
    currency: text().notNull(),
    description: text(),
    isProrated: boolean().notNull().default(false),

    source: chargeSourceEnum().notNull(),
    // 'YYYY-MM-DD' (the period start), DEPOSIT_GENERATION_KEY ('deposit'), or
    // OPENING_BALANCE_GENERATION_KEY ('opening'). NULL for every manual charge,
    // including every correction — see charge_generation_uq's comment for why NULL
    // here is load-bearing, not an oversight.
    generationKey: text(),
    // The correction chain. Self-referencing, restrict: a correction's predecessor
    // must never disappear out from under it.
    supersedesChargeId: uuid().references((): AnyPgColumn => charge.id, { onDelete: 'restrict' }),

    // The ONLY mutation this table ever accepts. All three are NULL until voided,
    // set together, exactly once.
    voidedAt: timestamp({ withTimezone: true }),
    // 10..500 chars, enforced by the contract's voidChargeBody/correctChargeBody.
    voidedReason: text(),
    voidedByUserId: text().references(() => user.id),

    // NULL means the generator wrote it — that is the audit signal, not a separate
    // column. Non-null for every manual charge (including corrections and voids'
    // originating correction row).
    createdByUserId: text().references(() => user.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

    // No updated_at. A table with no mutable field besides the void tombstone must
    // not imply one with a column that invites "just edit it this once".
  },
  (t) => [
    check('charge_amount_ck', sql`${t.amountCents} >= 0`),

    // THE CRON'S IDEMPOTENCY KEY. Plain, NOT partial on generation_key IS NOT NULL —
    // Postgres treats NULLs as distinct in a unique index by default (NULLS
    // DISTINCT, never set NULLS NOT DISTINCT here), so this single plain index
    // already permits unlimited manual rows (generation_key = NULL) while enforcing
    // uniqueness on every non-NULL one — the same constraint, smaller surface. A
    // PARTIAL unique index would need its predicate restated as `ON CONFLICT ...
    // WHERE generation_key IS NOT NULL` (Drizzle's targetWhere) on every insert that
    // uses it as an arbiter; omit that and the statement fails at runtime with "no
    // unique or exclusion constraint matching the ON CONFLICT specification" — on
    // the cron, at 09:00 UTC, writing nothing and telling nobody. A plain index
    // cannot be got wrong this way. Do NOT "fix" this back into a partial index.
    //
    // No predicate on voided_at either, and that is equally deliberate: a voided row
    // keeps its key, so the generator's ON CONFLICT DO NOTHING never re-creates a
    // charge the landlord deliberately voided. Adding `WHERE voided_at IS NULL` here
    // is the natural-looking "fix" that would silently resurrect a voided charge the
    // very next morning — voiding March's rent is a decision, not a gap to refill.
    //
    // Deliberately carries NO org_id. lease_id is already the PK of an org-scoped
    // table (lease), so adding org_id here would WIDEN the key without changing
    // uniqueness — the one-column-narrower form is STRICTER, not a tenancy miss.
    // Same reasoning as lease_unit_active_uq and lease_rent_step_uq above.
    uniqueIndex('charge_generation_uq').on(t.leaseId, t.generationKey),

    // The ledger page, and 3b's FIFO ordering, which sorts by (due_date, id) exactly.
    index('charge_lease_due_idx').on(t.orgId, t.leaseId, t.dueDate, t.id),

    // "What is due / overdue across my portfolio this month" — the /v1/charges page.
    index('charge_org_due_idx').on(t.orgId, t.dueDate).where(sql`${t.voidedAt} is null`),
  ],
);

/* ------------------------------------------------------------------ *
 * job_run — the one table with NO org_id, and that is correct: it describes the
 * SYSTEM (one cron run across every org), not a tenant. A reviewer applying the
 * tenancy guard's usual rule to this table would be checking the wrong thing —
 * say so here in as many words so it reads as a sanctioned exception, not a miss
 * (PLAN-PHASE3A.md §1.6).
 *
 * `stats` is jsonb precisely so Phase 4's reminder counters need no migration.
 * ------------------------------------------------------------------ */

export const jobRunStatusEnum = pgEnum('job_run_status', ['running', 'ok', 'failed']);

export const jobRun = pgTable(
  'job_run',
  {
    id: uuid().primaryKey(),
    // 'daily' today. Free-form rather than an enum: a second named job (Phase 4's
    // reminder sweep, say) should never need a migration just to be named.
    job: text().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    // NULL = still running, or the Worker died mid-run. A `running` row that never
    // finishes IS the failure signal the health endpoint reads (PLAN-PHASE3A.md
    // §4.4's table).
    finishedAt: timestamp({ withTimezone: true }),
    status: jobRunStatusEnum().notNull(),
    stats: jsonb().notNull().default({}),
    error: text(),
  },
  (t) => [
    // The health endpoint's ONLY query: ORDER BY started_at DESC LIMIT 1.
    index('job_run_job_started_idx').on(t.job, t.startedAt.desc()),
  ],
);
