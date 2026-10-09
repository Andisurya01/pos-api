CREATE TYPE "public"."discount_mode" AS ENUM('NONE', 'ITEM', 'TOTAL');--> statement-breakpoint
CREATE TYPE "public"."return_condition" AS ENUM('SELLABLE', 'DAMAGED');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('POSTED', 'VOIDED');--> statement-breakpoint
CREATE TABLE "held_sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shift_id" uuid NOT NULL,
	"label" text,
	"member_id" uuid,
	"cart" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sale_line_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"component_sku_id" uuid NOT NULL,
	"base_qty" numeric(18, 3) NOT NULL,
	"cost_amount" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"sku_id" uuid NOT NULL,
	"sku_unit_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"base_qty" numeric(18, 3) NOT NULL,
	"price_level" "price_level" NOT NULL,
	"unit_price" bigint NOT NULL,
	"original_unit_price" bigint,
	"price_override_pin_id" uuid,
	"gross_amount" bigint NOT NULL,
	"item_promo_id" uuid,
	"promo_discount" bigint NOT NULL,
	"manual_discount" bigint NOT NULL,
	"net_amount" bigint NOT NULL,
	"is_taxable" boolean NOT NULL,
	"tax_amount" bigint NOT NULL,
	"cost_amount" bigint NOT NULL,
	"scanned_code" text,
	"returned_base_qty" numeric(18, 3) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"tendered" bigint,
	"change" bigint,
	"reference_no" text
);
--> statement-breakpoint
CREATE TABLE "sale_voids" (
	"id" uuid PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"pin_approval_id" uuid,
	"business_date" date NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"journal_id" uuid,
	CONSTRAINT "sale_voids_docNo_unique" UNIQUE("doc_no"),
	CONSTRAINT "sale_voids_saleId_unique" UNIQUE("sale_id")
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"business_date" date NOT NULL,
	"shift_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"member_id" uuid,
	"status" "sale_status" DEFAULT 'POSTED' NOT NULL,
	"discount_mode" "discount_mode" NOT NULL,
	"total_promo_id" uuid,
	"gross_amount" bigint NOT NULL,
	"promo_discount_amount" bigint NOT NULL,
	"manual_discount_amount" bigint NOT NULL,
	"manual_discount_pin_id" uuid,
	"net_amount" bigint NOT NULL,
	"tax_rate" text NOT NULL,
	"tax_base" bigint NOT NULL,
	"tax_amount" bigint NOT NULL,
	"rounding_amount" bigint NOT NULL,
	"amount_due" bigint NOT NULL,
	"paid_amount" bigint NOT NULL,
	"change_amount" bigint NOT NULL,
	"cost_amount" bigint NOT NULL,
	"reprint_count" smallint DEFAULT 0 NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_id" uuid,
	CONSTRAINT "sales_docNo_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "sales_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"base_qty" numeric(18, 3) NOT NULL,
	"condition" "return_condition" NOT NULL,
	"to_location_id" uuid NOT NULL,
	"refund_amount" bigint NOT NULL,
	"tax_amount" bigint NOT NULL,
	"cost_amount" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_return_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"reference_no" text
);
--> statement-breakpoint
CREATE TABLE "sales_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"pin_approval_id" uuid,
	"refund_amount" bigint NOT NULL,
	"tax_amount" bigint NOT NULL,
	"rounding_amount" bigint NOT NULL,
	"business_date" date NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"journal_id" uuid,
	CONSTRAINT "sales_returns_docNo_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_line_components" ADD CONSTRAINT "sale_line_components_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_line_components" ADD CONSTRAINT "sale_line_components_component_sku_id_skus_id_fk" FOREIGN KEY ("component_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sku_unit_id_sku_units_id_fk" FOREIGN KEY ("sku_unit_id") REFERENCES "public"."sku_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_price_override_pin_id_pin_approvals_id_fk" FOREIGN KEY ("price_override_pin_id") REFERENCES "public"."pin_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_item_promo_id_promotions_id_fk" FOREIGN KEY ("item_promo_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_voids" ADD CONSTRAINT "sale_voids_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_voids" ADD CONSTRAINT "sale_voids_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_voids" ADD CONSTRAINT "sale_voids_pin_approval_id_pin_approvals_id_fk" FOREIGN KEY ("pin_approval_id") REFERENCES "public"."pin_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_voids" ADD CONSTRAINT "sale_voids_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_voids" ADD CONSTRAINT "sale_voids_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_total_promo_id_promotions_id_fk" FOREIGN KEY ("total_promo_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_manual_discount_pin_id_pin_approvals_id_fk" FOREIGN KEY ("manual_discount_pin_id") REFERENCES "public"."pin_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_return_id_sales_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."sales_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_refunds" ADD CONSTRAINT "sales_return_refunds_return_id_sales_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."sales_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_refunds" ADD CONSTRAINT "sales_return_refunds_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_pin_approval_id_pin_approvals_id_fk" FOREIGN KEY ("pin_approval_id") REFERENCES "public"."pin_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_shift_idx" ON "sales" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "sales_date_idx" ON "sales" USING btree ("business_date");