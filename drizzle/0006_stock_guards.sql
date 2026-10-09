-- The stock ledger is append-only, like the journal (docs/erd/README.md, aturan 3).
CREATE OR REPLACE TRIGGER stock_ledger_append_only
  BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER stock_ledger_no_truncate
  BEFORE TRUNCATE ON stock_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
-- Stock movements cannot be dated into a closed accounting period either.
CREATE OR REPLACE FUNCTION stock_ledger_period_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM periods
     WHERE status = 'CLOSED' AND NEW.business_date BETWEEN starts_on AND ends_on
  ) THEN
    RAISE EXCEPTION 'period of % is closed', NEW.business_date
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER stock_ledger_period_open
  BEFORE INSERT ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_period_trg();
