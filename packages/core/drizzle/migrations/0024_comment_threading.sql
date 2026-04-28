ALTER TABLE "comments" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_parent_id_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS comments_depth_check ON comments;--> statement-breakpoint
CREATE TRIGGER comments_depth_check BEFORE INSERT ON comments FOR EACH ROW EXECUTE FUNCTION enforce_comment_depth();
