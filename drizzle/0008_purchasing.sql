CREATE TYPE "public"."bill_status" AS ENUM('POSTED', 'PARTIALLY_PAID', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."return_offset" AS ENUM('GRNI', 'PAYABLE');--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"po_line_id" uuid,
	"sku_id" uuid NOT NULL,
	"sku_unit_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"base_qty" numeric(18, 3) NOT NULL,
	"unit_price" bigint NOT NULL,
	"line_value" bigint NOT NULL,
	"location_id" uuid NOT NULL,
	"batch_id" uuid,
	"billed_base_qty" numeric(18, 3) DEFAULT '0' NOT NULL,
	"returned_base_qty" numeric(18, 3) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"po_id" uuid,
	"is_direct" boolean DEFAULT false NOT NULL,
	"supplier_delivery_no" text,
	"total_value" bigint NOT NULL,
	"doc_no" text NOT NULL,
	"business_date" date NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "goods_receipts_docNo_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"sku_unit_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"base_qty" numeric(18, 3) NOT NULL,
	"unit_price" bigint NOT NULL,
	"line_amount" bigint NOT NULL,
	"received_base_qty" numeric(18, 3) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"status" "po_status" DEFAULT 'DRAFT' NOT NULL,
	"supplier_id" uuid NOT NULL,
	"order_date" date NOT NULL,
	"expected_date" date,
	"note" text,
	"subtotal" bigint DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"rejected_reason" text,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "purchase_orders_docNo_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "purchase_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"receipt_line_id" uuid,
	"sku_id" uuid NOT NULL,
	"batch_id" uuid,
	"base_qty" numeric(18, 3) NOT NULL,
	"line_amount" bigint NOT NULL,
	"cost_amount" bigint NOT NULL,
	"variance" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"reduces" "return_offset" NOT NULL,
	"debit_note_amount" bigint NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"applied_amount" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"doc_no" text NOT NULL,
	"business_date" date NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "purchase_returns_docNo_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "supplier_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"receipt_line_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"base_qty" numeric(18, 3) NOT NULL,
	"unit_price" bigint NOT NULL,
	"line_amount" bigint NOT NULL,
	"receipt_value" bigint NOT NULL,
	"price_variance" bigint NOT NULL,
	"allocated_shipping" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_bills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"is_opening" boolean DEFAULT false NOT NULL,
	"supplier_invoice_no" text NOT NULL,
	"tax_invoice_no" text,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" "bill_status" DEFAULT 'POSTED' NOT NULL,
	"subtotal" bigint NOT NULL,
	"shipping_cost" bigint DEFAULT 0 NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"total" bigint NOT NULL,
	"paid_amount" bigint DEFAULT 0 NOT NULL,
	"variance_approved_by" uuid,
	"doc_no" text NOT NULL,
	"business_date" date NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "supplier_bills_docNo_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"purchase_return_id" uuid
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"source_account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"bank_fee" bigint DEFAULT 0 NOT NULL,
	"reference_no" text,
	"doc_no" text NOT NULL,
	"business_date" date NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "supplier_payments_docNo_unique" UNIQUE("doc_no")
);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_po_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_sku_unit_id_sku_units_id_fk" FOREIGN KEY ("sku_unit_id") REFERENCES "public"."sku_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_sku_unit_id_sku_units_id_fk" FOREIGN KEY ("sku_unit_id") REFERENCES "public"."sku_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_return_id_purchase_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."purchase_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_bill_id_supplier_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_variance_approved_by_users_id_fk" FOREIGN KEY ("variance_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_id_supplier_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_bill_id_supplier_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_purchase_return_id_purchase_returns_id_fk" FOREIGN KEY ("purchase_return_id") REFERENCES "public"."purchase_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_source_account_id_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_receipts_supplier_idx" ON "goods_receipts" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "supplier_bills_supplier_idx" ON "supplier_bills" USING btree ("supplier_id","status");