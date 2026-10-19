-- ISS-1229 r19 — judge-54 at beta 907b85e: migration 0342 read every address in a stored title as a
-- person, an address inside an issue's own title or a project's name included ("test credentials
-- (another member)"), so the bell disagreed with the issue page. The master's ruling: only the slot
-- that names a person is swapped; an issue's title and a project's name are quoted as written.
-- For each stored title, on a record and on its bell row, whose issue, secondary issue or project
-- carries an address in its title or name, this reads that text as 0342 did, against the users table
-- as it stands, and puts the text back only where the title's own template quotes that kind of
-- text and the whole quoted part is that reading: an issue's title in a status change ("ISS-3 — <title>
-- moved to …"), a mention ('… mentioned you in "<title>"') or an intake notice ("Awaiting intake
-- review: <title>"), either of the last two behind the reference the delivery door leads with; a project's name in an invitation ("… invited you to <name> as <role>"), or, in a
-- title of no such template, as its " — <name>" ending or its "<name> — " opening. A person slot
-- ("waiting for another member's decision") and a status are never such a part. Every part is found
-- in the title as stored and replaced once; a title whose parts overlap, or that quotes neither the
-- text nor its reading, is left as it is and counted: nothing is guessed. The pattern is
-- lib/person-name.ts ADDRESS_PATTERN, and the reading is 0342's loop.
DO $$
DECLARE
  pat CONSTANT text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}';
  r record;
  quoted text;
  read_as text;
  found text;
  named text;
  at integer;
  opening boolean;
  m text[];
  slot_kind text;
  slot_at integer;
  slot_len integer;
  pos integer;
  len integer;
  holds boolean;
  starts integer[];
  lens integer[];
  texts text[];
  i integer;
  k integer;
  j integer;
  clash boolean;
  said text;
  restored integer := 0;
  left_alone integer := 0;
BEGIN
  FOR r IN
    SELECT x.kind, x.id, x.title, c.texts, c.sources
      FROM (
        SELECT 'record' AS kind, n.id, n.title, ARRAY[n.id] AS records
          FROM public.notifications n
        UNION ALL
        SELECT 'delivery', d.id, d.title, array_agg(m.notification_id)
          FROM public.notification_deliveries d
          JOIN public.notification_delivery_members m ON m.delivery_id = d.id
         WHERE d.title IS NOT NULL
         GROUP BY d.id, d.title
      ) x
      CROSS JOIN LATERAL (
        SELECT array_agg(q.txt ORDER BY q.src, q.txt) AS texts,
               array_agg(q.src ORDER BY q.src, q.txt) AS sources
          FROM (
            SELECT i.title AS txt, 'issue' AS src
              FROM public.notifications n
              JOIN public.issues i ON i.id IN (n.issue_id, n.secondary_issue_id)
             WHERE n.id = ANY (x.records) AND i.title ~ pat
            UNION
            SELECT p.name, 'project'
              FROM public.notifications n
              JOIN public.projects p ON p.id = n.project_id
             WHERE n.id = ANY (x.records) AND p.name ~ pat
          ) q
      ) c
     WHERE c.texts IS NOT NULL
  LOOP
    holds := false;
    starts := '{}';
    lens := '{}';
    texts := '{}';
    -- The one quoted part the title's template names, where it has one.
    slot_kind := NULL;
    m := regexp_match(r.title, '^((?:Resolved — )?[A-Za-z][A-Za-z0-9]{1,5}-[0-9]+ — )(.+)( moved to [^—]+)$');
    IF m IS NULL THEN
      m := regexp_match(r.title, '^((?:Resolved — )?(?:[A-Za-z][A-Za-z0-9]{1,5}-[0-9]+ — )?(?:@[^ ]+|someone) mentioned you in ")(.*)(")$');
    END IF;
    IF m IS NULL THEN
      m := regexp_match(r.title, '^((?:Resolved — )?(?:[A-Za-z][A-Za-z0-9]{1,5}-[0-9]+ — )?Awaiting intake review: )(.+)()$');
    END IF;
    IF m IS NOT NULL THEN
      slot_kind := 'issue';
    ELSE
      m := regexp_match(r.title, '^((?:Resolved — )?.+ invited you to )(.+)( as [a-z_]+)$');
      IF m IS NOT NULL THEN slot_kind := 'project'; END IF;
    END IF;
    IF m IS NOT NULL THEN
      slot_at := length(m[1]) + 1;
      slot_len := length(m[2]);
    END IF;

    FOR k IN 1 .. array_length(r.texts, 1) LOOP
      quoted := r.texts[k];
      IF position(quoted IN r.title) > 0 THEN
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
        len := length(read_as);
        pos := NULL;
        -- The opening reading is 0342's only at the title's start, and the inside one only after it.
        IF slot_kind IS NOT NULL THEN
          IF slot_kind = r.sources[k] AND opening = (slot_at = 1) AND slot_len = len
             AND substr(r.title, slot_at, len) = read_as THEN
            pos := slot_at;
          END IF;
        ELSIF r.sources[k] = 'project' THEN
          IF opening AND left(r.title, len + 3) = read_as || ' — ' THEN
            pos := 1;
          ELSIF NOT opening AND length(r.title) > len + 3 AND right(r.title, len + 3) = ' — ' || read_as THEN
            pos := length(r.title) - len + 1;
          END IF;
        END IF;
        IF pos IS NOT NULL THEN
          starts := starts || pos;
          lens := lens || len;
          texts := texts || quoted;
        END IF;
      END LOOP;
    END LOOP;

    clash := false;
    FOR i IN 1 .. coalesce(array_length(starts, 1), 0) LOOP
      FOR j IN 1 .. coalesce(array_length(starts, 1), 0) LOOP
        IF i <> j AND starts[i] < starts[j] + lens[j] AND starts[j] < starts[i] + lens[i] THEN
          clash := true;
        END IF;
      END LOOP;
    END LOOP;

    IF coalesce(array_length(starts, 1), 0) > 0 AND NOT clash THEN
      said := r.title;
      -- From the last place to the first, so each start still points into the title as stored.
      FOR i IN SELECT sub FROM generate_subscripts(starts, 1) sub ORDER BY starts[sub] DESC LOOP
        said := overlay(said PLACING texts[i] FROM starts[i] FOR lens[i]);
      END LOOP;
      IF r.kind = 'record' THEN
        UPDATE public.notifications SET title = said WHERE id = r.id;
      ELSE
        UPDATE public.notification_deliveries SET title = said WHERE id = r.id;
      END IF;
      restored := restored + 1;
    ELSIF NOT holds OR clash THEN
      left_alone := left_alone + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '0343: % stored title(s) quote an issue title or project name as written again; % that quote neither that text nor 0342''s reading of it were left as they are', restored, left_alone;
END $$;
