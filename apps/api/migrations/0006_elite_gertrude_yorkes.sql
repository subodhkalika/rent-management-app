CREATE TYPE "public"."charge_source" AS ENUM('generated', 'manual');--> statement-breakpoint
CREATE TYPE "public"."charge_type" AS ENUM('rent', 'deposit', 'opening_balance', 'late_fee', 'utility', 'other');--> statement-breakpoint
CREATE TYPE "public"."job_run_status" AS ENUM('running', 'ok', 'failed');--> statement-breakpoint
CREATE TABLE "charge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"type" charge_type NOT NULL,
	"period_start" date,
	"period_end" date,
	"period_index" integer,
	"occupied_start" date,
	"occupied_end" date,
	"days_occupied" integer,
	"days_in_period" integer,
	"due_date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"description" text,
	"is_prorated" boolean DEFAULT false NOT NULL,
	"source" charge_source NOT NULL,
	"generation_key" text,
	"supersedes_charge_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"voided_by_user_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_amount_ck" CHECK ("charge"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "job_run_status" NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_lease_id_lease_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."lease"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_supersedes_charge_id_charge_id_fk" FOREIGN KEY ("supersedes_charge_id") REFERENCES "public"."charge"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_voided_by_user_id_user_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charge_generation_uq" ON "charge" USING btree ("lease_id","generation_key");--> statement-breakpoint
CREATE INDEX "charge_lease_due_idx" ON "charge" USING btree ("org_id","lease_id","due_date","id");--> statement-breakpoint
CREATE INDEX "charge_org_due_idx" ON "charge" USING btree ("org_id","due_date") WHERE "charge"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "job_run_job_started_idx" ON "job_run" USING btree ("job","started_at" DESC NULLS LAST);