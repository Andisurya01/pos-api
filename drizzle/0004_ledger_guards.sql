-- Database-level guards for the general ledger (docs/erd/README.md, aturan integritas 1–3).

-- 1. Every posted journal balances and has at least two lines, checked at COMMIT
--    so lines can be inserted one by one inside the posting transaction.
CREATE OR REPLACE FUNCTION assert_journal_balanced(p_journal_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status journal_status;
  v_debit bigint;
  v_credit bigint;
  v_lines int;
BEGIN
  SELECT status INTO v_status FROM journals WHERE id = p_journal_id;
  IF v_status IS DISTINCT FROM 'POSTED' THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO v_debit, v_credit, v_lines
    FROM journal_lines WHERE journal_id = p_journal_id;
  IF v_lines < 2 OR v_debit <> v_credit THEN
    RAISE EXCEPTION 'journal % is not balanced: debit %, credit %, % lines',
      p_journal_id, v_debit, v_credit, v_lines
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_lines_balanced_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_journal_balanced(NEW.journal_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journals_balanced_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_journal_balanced(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_lines_balanced_trg();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journals_balanced
  AFTER INSERT OR UPDATE OF status ON journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journals_balanced_trg();
--> statement-breakpoint

-- 2. Lines are append-only; posted journals are immutable.
CREATE OR REPLACE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER journal_lines_no_truncate
  BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_posted_journal_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'posted journal % cannot be changed (%); post a reversal instead',
      OLD.journal_no, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER journals_posted_immutable
  BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_journal_change();
--> statement-breakpoint

-- 3. Nothing is posted into a closed period, and line dates match their journal.
CREATE OR REPLACE FUNCTION journal_lines_period_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_journal_date date;
BEGIN
  SELECT journal_date INTO v_journal_date FROM journals WHERE id = NEW.journal_id;
  IF v_journal_date IS DISTINCT FROM NEW.journal_date THEN
    RAISE EXCEPTION 'journal line date % differs from journal date %',
      NEW.journal_date, v_journal_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM periods
     WHERE status = 'CLOSED' AND NEW.journal_date BETWEEN starts_on AND ends_on
  ) THEN
    RAISE EXCEPTION 'period of % is closed', NEW.journal_date
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER journal_lines_period_open
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_period_trg();
