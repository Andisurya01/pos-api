CREATE TYPE "public"."discount_kind" AS ENUM('PERCENT', 'AMOUNT');--> statement-breakpoint
CREATE TYPE "public"."price_level" AS ENUM('RETAIL', 'WHOLESALE', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."promo_target" AS ENUM('SKU', 'CATEGORY', 'BRAND');--> statement-breakpoint
CREATE TYPE "public"."promo_type" AS ENUM('ITEM_DISCOUNT', 'TOTAL_DISCOUNT');--> statement-breakpoint
CREATE TYPE "public"."sku_kind" AS ENUM('STANDARD', 'BUNDLE');--> statement-breakpoint
CREATE TABLE "barcodes" (
	"barcode" text PRIMARY KEY NOT NULL,
	"sku_unit_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bundle_components" (
	"bundle_sku_id" uuid NOT NULL,
	"component_sku_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	CONSTRAINT "bundle_components_bundle_sku_id_component_sku_id_pk" PRIMARY KEY("bundle_sku_id","component_sku_id"),
	CONSTRAINT "bundle_components_check" CHECK ("bundle_components"."qty" > 0 and "bundle_components"."bundle_sku_id" <> "bundle_components"."component_sku_id")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text NOT NULL,
	"card_no" text,
	"joined_at" date DEFAULT current_date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "members_phone_unique" UNIQUE("phone"),
	CONSTRAINT "members_cardNo_unique" UNIQUE("card_no")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid NOT NULL,
	"brand_id" uuid,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "promotion_targets" (
	"promotion_id" uuid NOT NULL,
	"target_type" "promo_target" NOT NULL,
	"target_id" uuid NOT NULL,
	CONSTRAINT "promotion_targets_promotion_id_target_type_target_id_pk" PRIMARY KEY("promotion_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "promo_type" NOT NULL,
	"discount_kind" "discount_kind" NOT NULL,
	"discount_value" numeric(18, 4) NOT NULL,
	"max_discount" bigint,
	"min_purchase" bigint,
	"member_only" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"days_of_week" smallint[],
	"time_start" time,
	"time_end" time,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "promotions_period_check" CHECK ("promotions"."ends_at" > "promotions"."starts_at"),
	CONSTRAINT "promotions_value_check" CHECK ("promotions"."discount_value" > 0 and ("promotions"."discount_kind" <> 'PERCENT' or "promotions"."discount_value" <= 100))
);
--> statement-breakpoint
CREATE TABLE "sku_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku_unit_id" uuid NOT NULL,
	"level" "price_level" NOT NULL,
	"min_qty" numeric(18, 3) DEFAULT '1' NOT NULL,
	"price" bigint NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "sku_prices_values_check" CHECK ("sku_prices"."price" >= 0 and "sku_prices"."min_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "sku_supplier_prices" (
	"sku_unit_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"last_price" bigint NOT NULL,
	"last_receipt_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_supplier_prices_sku_unit_id_supplier_id_pk" PRIMARY KEY("sku_unit_id","supplier_id")
);
--> statement-breakpoint
CREATE TABLE "sku_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"factor" numeric(18, 3) NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"is_default_sale" boolean DEFAULT false NOT NULL,
	"is_default_purchase" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sku_units_factor_check" CHECK ("sku_units"."factor" > 0 and (not "sku_units"."is_base" or "sku_units"."factor" = 1))
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku_code" text NOT NULL,
	"variant_name" text,
	"variant_attrs" jsonb,
	"kind" "sku_kind" DEFAULT 'STANDARD' NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"is_weighed" boolean DEFAULT false NOT NULL,
	"is_taxable" boolean DEFAULT true NOT NULL,
	"track_batch" boolean DEFAULT false NOT NULL,
	"is_sellable" boolean DEFAULT true NOT NULL,
	"is_purchasable" boolean DEFAULT true NOT NULL,
	"min_stock" numeric(18, 3) DEFAULT '0' NOT NULL,
	"reorder_point" numeric(18, 3) DEFAULT '0' NOT NULL,
	"primary_supplier_id" uuid,
	"available_from" date,
	"available_until" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "skus_bundle_check" CHECK ("skus"."kind" <> 'BUNDLE' or (not "skus"."is_purchasable" and not "skus"."track_batch" and not "skus"."is_weighed"))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"contact_name" text,
	"is_pkp" boolean DEFAULT false NOT NULL,
	"npwp" text,
	"payment_term_days" smallint DEFAULT 0 NOT NULL,
	"lead_time_days" smallint DEFAULT 3 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code"),
	CONSTRAINT "suppliers_terms_check" CHECK ("suppliers"."payment_term_days" >= 0 and "suppliers"."lead_time_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"allows_decimal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_sku_unit_id_sku_units_id_fk" FOREIGN KEY ("sku_unit_id") REFERENCES "public"."sku_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_components" ADD CONSTRAINT "bundle_components_bundle_sku_id_skus_id_fk" FOREIGN KEY ("bundle_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_components" ADD CONSTRAINT "bundle_components_component_sku_id_skus_id_fk" FOREIGN KEY ("component_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_prices" ADD CONSTRAINT "sku_prices_sku_unit_id_sku_units_id_fk" FOREIGN KEY ("sku_unit_id") REFERENCES "public"."sku_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_prices" ADD CONSTRAINT "sku_prices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_supplier_prices" ADD CONSTRAINT "sku_supplier_prices_sku_unit_id_sku_units_id_fk" FOREIGN KEY ("sku_unit_id") REFERENCES "public"."sku_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_supplier_prices" ADD CONSTRAINT "sku_supplier_prices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_units" ADD CONSTRAINT "sku_units_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_units" ADD CONSTRAINT "sku_units_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_base_unit_id_units_id_fk" FOREIGN KEY ("base_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_primary_supplier_id_suppliers_id_fk" FOREIGN KEY ("primary_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "barcodes_sku_unit_idx" ON "barcodes" USING btree ("sku_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_name_uq" ON "brands" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "categories_parent_name_uq" ON "categories" USING btree (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "promotions_period_idx" ON "promotions" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "sku_prices_lookup_idx" ON "sku_prices" USING btree ("sku_unit_id","level","min_qty","effective_from" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sku_units_sku_unit_uq" ON "sku_units" USING btree ("sku_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_units_one_base_uq" ON "sku_units" USING btree ("sku_id") WHERE "sku_units"."is_base";--> statement-breakpoint
CREATE UNIQUE INDEX "skus_code_uq" ON "skus" USING btree (lower("sku_code"));--> statement-breakpoint
CREATE INDEX "skus_product_idx" ON "skus" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "units_code_uq" ON "units" USING btree (lower("code"));