CREATE TYPE "public"."unit_type" AS ENUM('flat', 'room', 'house', 'shutter', 'garage', 'office', 'other');--> statement-breakpoint
ALTER TABLE "unit" ALTER COLUMN "bedrooms" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "unit" ALTER COLUMN "bedrooms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "unit" ALTER COLUMN "bathrooms" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "unit" ALTER COLUMN "bathrooms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "unit" ADD COLUMN "type" "unit_type" DEFAULT 'flat' NOT NULL;