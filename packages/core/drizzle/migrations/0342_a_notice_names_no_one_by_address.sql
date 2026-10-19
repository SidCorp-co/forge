-- ISS-1229 r18 — judge-48: a member with no display name was named by their email address in the
-- titles of notices and bell rows ("ISS-3 is waiting for <address>'s decision"). A title is stored,
-- so the address stayed for good. The master's ruling: a notice or bell row never shows an address as
-- a person's name. Each address in a stored title, on the record and on its bell row, takes what core
-- now calls that person (lib/person-name.ts personName as of this migration): the user's display name,
-- or "another member" ("Another member" where the title opens with it) where the user has none, the
-- display name holds an address itself, or the address is no user's. A title holding no address is
-- left as it is. The pattern is lib/person-name.ts ADDRESS_PATTERN.
DO $$
DECLARE
  pat CONSTANT text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}';
  r record;
  said text;
  found text;
  named text;
  rewritten integer := 0;
BEGIN
  FOR r IN
    SELECT 'record' AS kind, n.id, n.title FROM public.notifications n WHERE n.title ~ pat
    UNION ALL
    SELECT 'delivery', d.id, d.title FROM public.notification_deliveries d WHERE d.title ~ pat
  LOOP
    said := r.title;
    LOOP
      found := substring(said FROM pat);
      EXIT WHEN found IS NULL;
      named := NULL;
      SELECT regexp_replace(u.display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g') INTO named
        FROM public.users u
       WHERE lower(u.email) = lower(found)
         AND nullif(regexp_replace(u.display_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
         AND u.display_name !~ pat
       LIMIT 1;
      said := replace(
        said,
        found,
        coalesce(named, CASE WHEN left(said, length(found)) = found THEN 'Another member' ELSE 'another member' END)
      );
    END LOOP;
    IF r.kind = 'record' THEN
      UPDATE public.notifications SET title = said WHERE id = r.id;
    ELSE
      UPDATE public.notification_deliveries SET title = said WHERE id = r.id;
    END IF;
    rewritten := rewritten + 1;
  END LOOP;
  RAISE NOTICE '0342: % stored title(s) named a person by address and now read their name', rewritten;
END $$;
