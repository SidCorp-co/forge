-- Hardens the depth-3 trigger from 0024:
--   1. Cover UPDATE OF parent_id so re-parenting can't bypass the depth check.
--   2. Add an absolute iteration ceiling so a corrupt cycle (e.g. parent
--      pointer loop introduced via direct SQL) raises a clear cycle error
--      instead of pinning the connection.

CREATE OR REPLACE FUNCTION enforce_comment_depth() RETURNS trigger AS $$
DECLARE
  d integer := 1;
  cur uuid := NEW.parent_id;
BEGIN
  WHILE cur IS NOT NULL LOOP
    d := d + 1;
    IF d > 100 THEN
      RAISE EXCEPTION 'comment parent chain exceeded 100 — likely cycle (id=%)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF d > 3 THEN
      RAISE EXCEPTION 'comment depth exceeds 3' USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO cur FROM comments WHERE id = cur;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS comments_depth_check ON comments;--> statement-breakpoint
CREATE TRIGGER comments_depth_check
  BEFORE INSERT OR UPDATE OF parent_id ON comments
  FOR EACH ROW EXECUTE FUNCTION enforce_comment_depth();
