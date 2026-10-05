CREATE TYPE "public"."calendar_system" AS ENUM('gregorian', 'bikram_sambat');--> statement-breakpoint
CREATE TYPE "public"."move_out_billing_policy" AS ENUM('bill_full_term', 'stop_at_move_out');--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "move_out_billing_policy" "move_out_billing_policy" DEFAULT 'bill_full_term' NOT NULL;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "calendar" "calendar_system" DEFAULT 'gregorian' NOT NULL;