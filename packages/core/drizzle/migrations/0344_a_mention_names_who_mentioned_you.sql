-- ISS-1229 r20 — judge-59 at beta 9974765: a mention notice named who mentioned you as "@" and the
-- part of their address before the "@" ('@lan.pham mentioned you in "…"'), the one person slot that
-- still read an address. notifications/notify-mentions.ts now fills it through lib/person-name.ts
-- personName at a sentence's start: the display name, else "Another member" (also where the display
-- name is blank or holds an address). This rewrites the mention titles already stored, on the record
-- and on its bell row, behind the delivery door's optional "Resolved — " and issue-reference leads.
-- A handle is tied to a person only where exactly one user's address has that part before the "@",
-- or, where several do, exactly one of them wrote a comment on the mention's issue; any other handle
-- is left as it is and counted. The "someone" the producer printed when it found no user names
-- nobody, and reads "Another member". The pattern is lib/person-name.ts ADDRESS_PATTERN.
DO $$
DECLARE
  pat CONSTANT text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}';
  r record;
  m text[];
  matches integer;
  who uuid;
  named text;
  rewritten integer := 0;
  left_alone integer := 0;
BEGIN
  FOR r IN
    SELECT 'record' AS kind, n.id, n.title, ARRAY[n.issue_id] AS issue_ids
      FROM public.notifications n
     WHERE n.type = 'mention'
    UNION ALL
    SELECT 'delivery', d.id, d.title, array_agg(n.issue_id)
      FROM public.notification_deliveries d
      JOIN public.notification_delivery_members dm ON dm.delivery_id = d.id
      JOIN public.notifications n ON n.id = dm.notification_id
     WHERE d.title IS NOT NULL
     GROUP BY d.id, d.title
    HAVING bool_and(n.type = 'mention')
  LOOP
    m := regexp_match(r.title, '^((?:Resolved — )?(?:[A-Za-z][A-Za-z0-9]{1,5}-[0-9]+ — )?)(@[^ ]+|someone)( mentioned you in ".*")$');
    CONTINUE WHEN m IS NULL;

    named := NULL;
    IF m[2] = 'someone' THEN
      named := 'Another member';
    ELSE
      SELECT count(*), min(u.id::text)::uuid INTO matches, who
        FROM public.users u
       WHERE split_part(u.email, '@', 1) = substr(m[2], 2);
      IF matches > 1 THEN
        SELECT count(DISTINCT u.id), min(u.id::text)::uuid INTO matches, who
          FROM public.users u
          JOIN public.comments c ON c.author_id = u.id
         WHERE split_part(u.email, '@', 1) = substr(m[2], 2)
           AND c.issue_id = ANY (r.issue_ids);
      END IF;
      IF matches = 1 THEN
        SELECT CASE
                 WHEN nullif(regexp_replace(u.display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NULL
                   OR u.display_name ~ pat
                 THEN 'Another member'
                 ELSE regexp_replace(u.display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g')
               END INTO named
          FROM public.users u
         WHERE u.id = who;
      END IF;
    END IF;

    IF named IS NULL THEN
      left_alone := left_alone + 1;
      CONTINUE;
    END IF;
    IF r.kind = 'record' THEN
      UPDATE public.notifications SET title = m[1] || named || m[3] WHERE id = r.id;
    ELSE
      UPDATE public.notification_deliveries SET title = m[1] || named || m[3] WHERE id = r.id;
    END IF;
    rewritten := rewritten + 1;
  END LOOP;
  RAISE NOTICE '0344: % stored mention title(s) now name who mentioned the reader as core calls them; % whose handle names no one person were left as they are', rewritten, left_alone;
END $$;
