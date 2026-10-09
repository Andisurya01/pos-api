CREATE TYPE "public"."account_type" AS ENUM('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."cash_flow_group" AS ENUM('OPERATING', 'INVESTING', 'FINANCING');--> statement-breakpoint
CREATE TYPE "public"."cash_kind" AS ENUM('DRAWER', 'CASH', 'PETTY_CASH', 'BANK', 'CLEARING');--> statement-breakpoint
CREATE TYPE "public"."dc" AS ENUM('DEBIT', 'CREDIT');--> statement-breakpoint
CREATE TYPE "public"."journal_source" AS ENUM('AUTO', 'MANUAL', 'OPENING', 'CLOSING');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'POSTED');--> statement-breakpoint
CREATE TYPE "public"."mapping_key" AS ENUM('INVENTORY', 'GRNI', 'COGS', 'SALES', 'SALES_DISCOUNT', 'SALES_RETURN', 'VAT_OUT', 'ROUNDING_GAIN', 'ROUNDING_LOSS', 'ACCOUNTS_PAYABLE', 'VAT_IN', 'PURCHASE_RETURN_VARIANCE', 'MAIN_CASH', 'CASH_OVER', 'CASH_SHORT', 'MDR_EXPENSE', 'BANK_FEE', 'INV_SHRINKAGE', 'INV_GAIN', 'DAMAGE_EXPENSE', 'SELF_USE_EXPENSE', 'PROMO_EXPENSE', 'OPENING_EQUITY', 'CURRENT_YEAR_EARNINGS', 'RETAINED_EARNINGS');--> statement-breakpoint
CREATE TYPE "public"."period_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "account_mappings" (
	"key" "mapping_key" PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"normal_balance" "dc" NOT NULL,
	"parent_id" uuid,
	"is_postable" boolean DEFAULT true NOT NULL,
	"is_control" boolean DEFAULT false NOT NULL,
	"cash_kind" "cash_kind",
	"cash_flow_group" "cash_flow_group",
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "accounts_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"bank_name" text NOT NULL,
	"account_no" text NOT NULL,
	"holder_name" text NOT NULL,
	"import_mapping" text
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journal_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	"journal_date" date NOT NULL,
	"supplier_id" uuid,
	"sku_id" uuid,
	CONSTRAINT "journal_lines_amount_check" CHECK ("journal_lines"."debit" >= 0 and "journal_lines"."credit" >= 0 and ("journal_lines"."debit" = 0) <> ("journal_lines"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_no" text NOT NULL,
	"journal_date" date NOT NULL,
	"period_id" char(7) NOT NULL,
	"source" "journal_source" NOT NULL,
	"source_doc_type" text,
	"source_doc_id" uuid,
	"description" text NOT NULL,
	"status" "journal_status" DEFAULT 'POSTED' NOT NULL,
	"reversal_of_id" uuid,
	"approved_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "journals_journalNo_unique" UNIQUE("journal_no"),
	CONSTRAINT "journals_reversalOfId_unique" UNIQUE("reversal_of_id")
);
--> statement-breakpoint
CREATE TABLE "periods" (
	"id" char(7) PRIMARY KEY NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "period_status" DEFAULT 'OPEN' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopened_by" uuid,
	"reopen_reason" text,
	"closing_journal_id" uuid,
	CONSTRAINT "periods_range_check" CHECK ("periods"."ends_on" >= "periods"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_period_id_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_reversal_of_id_journals_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periods" ADD CONSTRAINT "periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periods" ADD CONSTRAINT "periods_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_parent_idx" ON "accounts" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_date_idx" ON "journal_lines" USING btree ("account_id","journal_date");--> statement-breakpoint
CREATE INDEX "journal_lines_journal_idx" ON "journal_lines" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "journals_source_doc_idx" ON "journals" USING btree ("source_doc_type","source_doc_id");--> statement-breakpoint
CREATE INDEX "journals_date_idx" ON "journals" USING btree ("journal_date");