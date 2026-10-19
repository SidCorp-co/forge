-- ISS-1229 r17 — a status-change notice titled before round 16 named the status it moved to as stored:
-- "ISS-22 — Fix the export moved to needs_info". Round 16 words new titles ("moved to Needs info"), and
-- the rows already written still read the stored value in every bell. Each such title, on the record
-- and on the bell row that carries it, takes the status's label. The labels are core's
-- ISSUE_STATUS_LABELS (issues/status-sets.ts) as of this migration; a title ending in no stored status
-- is left as it is.
WITH words(stored, label) AS (
  VALUES ('open', 'Open'), ('confirmed', 'Confirmed'), ('clarified', 'Clarified'),
         ('waiting', 'Waiting'), ('approved', 'Approved'), ('in_progress', 'In progress'),
         ('developed', 'Developed'), ('testing', 'Testing'), ('tested', 'Tested'),
         ('awaiting_release', 'Awaiting release'), ('releasing', 'Releasing'), ('closed', 'Closed'),
         ('reopen', 'Reopened'), ('on_hold', 'On hold'), ('needs_info', 'Needs info'),
         ('draft', 'Draft'), ('dropped', 'Dropped')
)
UPDATE notification_deliveries d
   SET title = left(d.title, length(d.title) - length(w.stored)) || w.label
  FROM words w, notification_delivery_members m, notifications n
 WHERE m.delivery_id = d.id AND n.id = m.notification_id
   AND n.type = 'issue_status_changed'
   AND d.group_key IS NULL
   AND right(d.title, length(w.stored) + 10) = ' moved to ' || w.stored;--> statement-breakpoint
WITH words(stored, label) AS (
  VALUES ('open', 'Open'), ('confirmed', 'Confirmed'), ('clarified', 'Clarified'),
         ('waiting', 'Waiting'), ('approved', 'Approved'), ('in_progress', 'In progress'),
         ('developed', 'Developed'), ('testing', 'Testing'), ('tested', 'Tested'),
         ('awaiting_release', 'Awaiting release'), ('releasing', 'Releasing'), ('closed', 'Closed'),
         ('reopen', 'Reopened'), ('on_hold', 'On hold'), ('needs_info', 'Needs info'),
         ('draft', 'Draft'), ('dropped', 'Dropped')
)
UPDATE notifications n
   SET title = left(n.title, length(n.title) - length(w.stored)) || w.label
  FROM words w
 WHERE n.type = 'issue_status_changed'
   AND right(n.title, length(w.stored) + 10) = ' moved to ' || w.stored;
