CREATE TYPE "public"."tenant_status" AS ENUM('prospect', 'active', 'past', 'archived');--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"status" "tenant_status" DEFAULT 'prospect' NOT NULL,
	"reminders_opted_out" boolean DEFAULT false NOT NULL,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_invite" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invite" ADD CONSTRAINT "tenant_invite_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invite" ADD CONSTRAINT "tenant_invite_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invite" ADD CONSTRAINT "tenant_invite_accepted_user_id_user_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invite" ADD CONSTRAINT "tenant_invite_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_org_idx" ON "tenant" USING btree ("org_id","deleted_at");--> statement-breakpoint
CREATE INDEX "tenant_user_idx" ON "tenant" USING btree ("user_id") WHERE "tenant"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_org_user_uq" ON "tenant" USING btree ("org_id","user_id") WHERE "tenant"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_org_email_uq" ON "tenant" USING btree ("org_id",lower("email")) WHERE "tenant"."email" is not null and "tenant"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_invite_token_uq" ON "tenant_invite" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "tenant_invite_tenant_idx" ON "tenant_invite" USING btree ("org_id","tenant_id");