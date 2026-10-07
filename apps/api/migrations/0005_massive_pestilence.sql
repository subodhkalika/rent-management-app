CREATE TYPE "public"."rent_escalation_compounding" AS ENUM('compound', 'simple');--> statement-breakpoint
CREATE TYPE "public"."rent_escalation_mode" AS ENUM('none', 'percent');--> statement-breakpoint
CREATE TYPE "public"."rent_step_source" AS ENUM('clause', 'manual');--> statement-breakpoint
CREATE TABLE "lease_rent_step" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"rent_cents" bigint NOT NULL,
	"source" "rent_step_source" NOT NULL,
	"clause_expected_cents" bigint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_rent_step_money_ck" CHECK ("lease_rent_step"."rent_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lease_rent_step_correction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"old_rent_cents" bigint NOT NULL,
	"new_rent_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"corrected_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lease" ADD COLUMN "escalation_mode" "rent_escalation_mode" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "lease" ADD COLUMN "escalation_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "lease" ADD COLUMN "escalation_interval_years" smallint;--> statement-breakpoint
ALTER TABLE "lease" ADD COLUMN "escalation_compounding" "rent_escalation_compounding";--> statement-breakpoint
ALTER TABLE "lease" ADD COLUMN "escalation_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lease" ADD COLUMN "escalation_updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "lease_rent_step" ADD CONSTRAINT "lease_rent_step_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_rent_step" ADD CONSTRAINT "lease_rent_step_lease_id_lease_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."lease"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_rent_step_correction" ADD CONSTRAINT "lease_rent_step_correction_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_rent_step_correction" ADD CONSTRAINT "lease_rent_step_correction_lease_id_lease_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."lease"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_rent_step_correction" ADD CONSTRAINT "lease_rent_step_correction_step_id_lease_rent_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."lease_rent_step"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_rent_step_correction" ADD CONSTRAINT "lease_rent_step_correction_corrected_by_user_id_user_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lease_rent_step_uq" ON "lease_rent_step" USING btree ("lease_id","effective_from");--> statement-breakpoint
CREATE INDEX "lease_rent_step_idx" ON "lease_rent_step" USING btree ("org_id","lease_id","effective_from");--> statement-breakpoint
CREATE INDEX "lease_rent_step_correction_idx" ON "lease_rent_step_correction" USING btree ("org_id","lease_id","created_at");--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_escalation_updated_by_user_id_user_id_fk" FOREIGN KEY ("escalation_updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_escalation_ck" CHECK (("lease"."escalation_mode" = 'none' and "lease"."escalation_rate_bps" is null and "lease"."escalation_interval_years" is null and "lease"."escalation_compounding" is null)
          or
          ("lease"."escalation_mode" = 'percent' and "lease"."escalation_rate_bps" between 1 and 5000 and "lease"."escalation_interval_years" between 1 and 10 and "lease"."escalation_compounding" is not null));