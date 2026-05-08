-- ISS-61 — add sort_order to tasks for explicit subtask ordering on
-- the issue detail panel (drag-drop). Defaults to 0 for existing rows; new
-- rows are inserted at max(sort_order)+1 by the route handler.
ALTER TABLE tasks ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
CREATE INDEX tasks_issue_sort_idx ON tasks(issue_id, sort_order);
