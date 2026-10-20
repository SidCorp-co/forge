-- ISS-1229 r21 — judge-60 at beta 7f539ee: deleting a project took its notices and their
-- notification_delivery_members rows by cascade, and left each bell row (notification_deliveries)
-- holding none, its title and all; beta held 748. A statement-level trigger now removes each bell row
-- a delete leaves with no member, in the same transaction, whatever removed the notices (a project's
-- or an organization's delete, the stale-condition sweep); a row still holding another notice stays.
-- The rows already left empty are removed once here. notifications/deliver.ts writes a row and its
-- first member in one transaction, so no live row is ever empty.
--
-- The master's ruling of the same round: a personal workspace is never named by its owner's address.
-- One still carrying the part of the address before the "@" (0106's backfill and ensurePersonalOrg's
-- old default), or "personal", is named by the owner's display name, else "Personal" — the display
-- name read as lib/person-name.ts personName reads it (trimmed, and never one holding an address).
--
-- Rollback: DROP TRIGGER notification_delivery_members_empty_delivery ON notification_delivery_members;
-- DROP FUNCTION remove_empty_notification_deliveries(); the removed rows and the names stay.
CREATE OR REPLACE FUNCTION remove_empty_notification_deliveries()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Locked first, and read again by a statement of its own: two transactions each removing one of
  -- a row's last two notices would otherwise each see the other's still standing, and keep it.
  PERFORM 1 FROM public.notification_deliveries d
   WHERE d.id IN (SELECT DISTINCT gone.delivery_id FROM gone)
   ORDER BY d.id
   FOR UPDATE;
  DELETE FROM public.notification_deliveries d
   WHERE d.id IN (SELECT DISTINCT gone.delivery_id FROM gone)
     AND NOT EXISTS (
       SELECT 1 FROM public.notification_delivery_members m WHERE m.delivery_id = d.id
     );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_delivery_members_empty_delivery ON public.notification_delivery_members;
--> statement-breakpoint
CREATE TRIGGER notification_delivery_members_empty_delivery
  AFTER DELETE ON public.notification_delivery_members
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT
  EXECUTE FUNCTION remove_empty_notification_deliveries();
--> statement-breakpoint
DO $$
DECLARE
  pat CONSTANT text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}';
  removed integer;
  renamed integer;
BEGIN
  DELETE FROM public.notification_deliveries d
   WHERE NOT EXISTS (
     SELECT 1 FROM public.notification_delivery_members m WHERE m.delivery_id = d.id
   );
  GET DIAGNOSTICS removed = ROW_COUNT;

  WITH named AS (
    SELECT o.id,
           CASE
             WHEN nullif(regexp_replace(u.display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NULL
               OR u.display_name ~ pat
             THEN 'Personal'
             ELSE regexp_replace(u.display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g')
           END AS name
      FROM public.organizations o
      JOIN public.users u ON u.id = o.created_by
     WHERE o.is_personal
       AND (o.name = split_part(u.email, '@', 1) OR o.name = 'personal')
  )
  UPDATE public.organizations o
     SET name = named.name
    FROM named
   WHERE o.id = named.id
     AND o.name IS DISTINCT FROM named.name;
  GET DIAGNOSTICS renamed = ROW_COUNT;

  RAISE NOTICE '0346: % bell row(s) holding no notice removed; % personal workspace(s) named by their owner''s address renamed', removed, renamed;
END $$;
