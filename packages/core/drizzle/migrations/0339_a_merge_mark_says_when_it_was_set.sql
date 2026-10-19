-- ISS-1229 r16 — when a merge mark was set. `merged_at` is when the code merged, and a mark read off
-- the repository carries that commit's time, hours older than the mark itself: the owed-close notice
-- counted from it and said "carried a merge mark for 7 hours" of a mark four minutes old, and was
-- raised six hours early. The one merge writer stamps this column and the unmark clears it. A mark
-- made before this column existed has none, and the sweep counts it from `merged_at` as it did:
-- nothing stored says when those marks were set, so none is invented for them.
ALTER TABLE "issues" ADD COLUMN "merge_marked_at" timestamp with time zone;
