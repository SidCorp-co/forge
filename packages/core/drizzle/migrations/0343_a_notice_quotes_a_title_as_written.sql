-- ISS-1229 r19 — judge-54 at beta 907b85e: migration 0342 read every address in a stored title as a
-- person, an address inside an issue's own title or a project's name included ("test credentials
-- (another member)"), so the bell disagreed with the issue page. The master's ruling: only the slot
-- that names a person is swapped; an issue's title and a project's name are quoted as written.
-- For each stored title, on a record and on its bell row, whose issue, secondary issue or project
-- carries an address in its title or name, this reads that text as 0342 did, against the users table
-- as it stands, and where the stored title holds that reading puts the text back as written. A title
-- holding neither the text nor that reading is left as it is and counted: nothing is guessed. The
-- pattern is lib/person-name.ts ADDRESS_PATTERN, and the reading is 0342's loop.
DO $$
DECLARE
  pat CONSTANT text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}';
  r record;
  quoted text;
  said text;
  read_as text;
  found text;
  named text;
  at integer;
  opening boolean;
  holds boolean;
  restored integer := 0;
  left_alone integer := 0;
BEGIN
  FOR r IN
    SELECT 'record' AS kind, n.id, n.title,
           array_remove(ARRAY[i.title, si.title, p.name], NULL) AS texts
      FROM public.notifications n
      LEFT JOIN public.issues i ON i.id = n.issue_id
      LEFT JOIN public.issues si ON si.id = n.secondary_issue_id
      LEFT JOIN public.projects p ON p.id = n.project_id
     WHERE i.title ~ pat OR si.title ~ pat OR p.name ~ pat
    UNION ALL
    SELECT 'delivery', d.id, d.title,
           array_remove(array_agg(DISTINCT i.title) || array_agg(DISTINCT si.title)
                        || array_agg(DISTINCT p.name), NULL)
      FROM public.notification_deliveries d
      JOIN public.notification_delivery_members m ON m.delivery_id = d.id
      JOIN public.notifications n ON n.id = m.notification_id
      LEFT JOIN public.issues i ON i.id = n.issue_id
      LEFT JOIN public.issues si ON si.id = n.secondary_issue_id
      LEFT JOIN public.projects p ON p.id = n.project_id
     WHERE d.title IS NOT NULL
     GROUP BY d.id, d.title
    HAVING bool_or(coalesce(i.title ~ pat, false) OR coalesce(si.title ~ pat, false)
                   OR coalesce(p.name ~ pat, false))
  LOOP
    said := r.title;
    holds := false;
    FOREACH quoted IN ARRAY r.texts LOOP
      CONTINUE WHEN quoted !~ pat;
      IF position(quoted IN said) > 0 THEN
        holds := true;
        CONTINUE;
      END IF;
      FOREACH opening IN ARRAY ARRAY[true, false] LOOP
        read_as := quoted;
        LOOP
          found := substring(read_as FROM pat);
          EXIT WHEN found IS NULL;
          named := NULL;
          SELECT regexp_replace(u.display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g') INTO named
            FROM public.users u
           WHERE lower(u.email) = lower(found)
             AND nullif(regexp_replace(u.display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
             AND u.display_name !~ pat
           LIMIT 1;
          at := position(found IN read_as);
          read_as := overlay(
            read_as PLACING coalesce(named, CASE WHEN opening AND at = 1 THEN 'Another member' ELSE 'another member' END)
            FROM at FOR length(found)
          );
        END LOOP;
        IF opening THEN
          IF left(said, length(read_as)) = read_as THEN
            said := quoted || substr(said, length(read_as) + 1);
          END IF;
        ELSIF position(read_as IN said) > 0 THEN
          said := replace(said, read_as, quoted);
        END IF;
      END LOOP;
      IF position(quoted IN said) > 0 THEN holds := true; END IF;
    END LOOP;
    IF said <> r.title THEN
      IF r.kind = 'record' THEN
        UPDATE public.notifications SET title = said WHERE id = r.id;
      ELSE
        UPDATE public.notification_deliveries SET title = said WHERE id = r.id;
      END IF;
      restored := restored + 1;
    ELSIF NOT holds THEN
      left_alone := left_alone + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '0343: % stored title(s) quote an issue title or project name as written again; % holding neither that text nor 0342''s reading of it were left as they are', restored, left_alone;
END $$;
