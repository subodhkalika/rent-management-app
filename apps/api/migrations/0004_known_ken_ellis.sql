CREATE TYPE "public"."lease_status" AS ENUM('draft', 'active', 'ended', 'terminated', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rent_frequency" AS ENUM('monthly', 'yearly');--> statement-breakpoint
CREATE TABLE "lease" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"unit_id" uuid NOT NULL,
	"chain_id" uuid NOT NULL,
	"renewed_from_lease_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date,
	"move_out_date" date,
	"rent_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"rent_frequency" "rent_frequency" DEFAULT 'monthly' NOT NULL,
	"billing_day" smallint DEFAULT 1 NOT NULL,
	"deposit_cents" bigint DEFAULT 0 NOT NULL,
	"opening_balance_cents" bigint DEFAULT 0 NOT NULL,
	"ledger_start_date" date NOT NULL,
	"status" "lease_status" DEFAULT 'draft' NOT NULL,
	"end_reason" text,
	"end_note" text,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_dates_ck" CHECK ("lease"."end_date" is null or "lease"."end_date" >= "lease"."start_date"),
	CONSTRAINT "lease_ledger_ck" CHECK ("lease"."ledger_start_date" >= "lease"."start_date" and ("lease"."end_date" is null or "lease"."ledger_start_date" <= "lease"."end_date")),
	CONSTRAINT "lease_billing_day_ck" CHECK ("lease"."billing_day" between 1 and 32),
	CONSTRAINT "lease_money_ck" CHECK ("lease"."rent_cents" >= 0 and "lease"."deposit_cents" >= 0 and "lease"."opening_balance_cents" >= 0),
	CONSTRAINT "lease_moveout_ck" CHECK ("lease"."move_out_date" is null or "lease"."move_out_date" >= "lease"."start_date")
);
--> statement-breakpoint
CREATE TABLE "lease_tenant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"added_on" date NOT NULL,
	"removed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_tenant_ck" CHECK ("lease_tenant"."removed_on" is null or "lease_tenant"."removed_on" >= "lease_tenant"."added_on")
);
--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_renewed_from_lease_id_lease_id_fk" FOREIGN KEY ("renewed_from_lease_id") REFERENCES "public"."lease"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_tenant" ADD CONSTRAINT "lease_tenant_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_tenant" ADD CONSTRAINT "lease_tenant_lease_id_lease_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."lease"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_tenant" ADD CONSTRAINT "lease_tenant_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lease_org_unit_idx" ON "lease" USING btree ("org_id","unit_id","status");--> statement-breakpoint
CREATE INDEX "lease_chain_idx" ON "lease" USING btree ("org_id","chain_id");--> statement-breakpoint
CREATE INDEX "lease_org_status_start_idx" ON "lease" USING btree ("org_id","status","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "lease_unit_active_uq" ON "lease" USING btree ("unit_id") WHERE "lease"."status" = 'active'::lease_status;--> statement-breakpoint
CREATE INDEX "lease_tenant_lease_idx" ON "lease_tenant" USING btree ("org_id","lease_id");--> statement-breakpoint
CREATE INDEX "lease_tenant_tenant_idx" ON "lease_tenant" USING btree ("org_id","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lease_tenant_live_uq" ON "lease_tenant" USING btree ("lease_id","tenant_id") WHERE "lease_tenant"."removed_on" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "lease_tenant_primary_uq" ON "lease_tenant" USING btree ("lease_id") WHERE "lease_tenant"."is_primary" and "lease_tenant"."removed_on" is null;