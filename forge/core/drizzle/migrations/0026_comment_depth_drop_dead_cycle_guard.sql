-- Drops the unreachable d > 100 cycle guard introduced in 0025. The branch
-- sat after `d := d + 1` but before `IF d > 3 THEN ... RAISE`, so for any
-- chain (legitimate or cyclic) the depth check at d=4 always fired first and
-- the cycle branch never executed. The d > 3 raise already terminates the
-- function on cycles, so removing the dead branch is the honest fix.
--
-- Trigger registration is unchanged (still BEFORE INSERT OR UPDATE OF
-- parent_id from 0025).

CREATE OR REPLACE FUNCTION enforce_comment_depth() RETURNS trigger AS $$
DECLARE
  d integer := 1;
  cur uuid := NEW.parent_id;
BEGIN
  WHILE cur IS NOT NULL LOOP
    d := d + 1;
    IF d > 3 THEN
      RAISE EXCEPTION 'comment depth exceeds 3' USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO cur FROM comments WHERE id = cur;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
