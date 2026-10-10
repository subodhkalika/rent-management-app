CREATE TYPE "public"."payment_kind" AS ENUM('payment', 'refund');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('bank_transfer', 'cash', 'cheque', 'card_external', 'upi', 'other');--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"received_on" date NOT NULL,
	"reference" text,
	"note" text,
	"supersedes_payment_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"voided_by_user_id" text,
	"recorded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_ck" CHECK ("payment"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_lease_id_lease_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."lease"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_supersedes_payment_id_payment_id_fk" FOREIGN KEY ("supersedes_payment_id") REFERENCES "public"."payment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_voided_by_user_id_user_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_lease_received_idx" ON "payment" USING btree ("org_id","lease_id","received_on","id");