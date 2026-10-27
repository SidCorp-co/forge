-- ISS-1229 r49 — judge-146: a person with no display name was named two ways, "Another member" by every
-- notice, list and hint, and "A member" by the room that signs their messages. The coordinator's ruling:
-- every surface uses the room's words, so lib/person-name.ts now calls them "a member" ("A member" opening
-- a sentence or standing as a label). What core wrote in the old word before this deploy is stored, so it
-- is re-rendered here, and only where the slot holds nothing but that fallback: the person slot of a
-- stored template, never an issue's title or a project's name that happens to quote the words.
--
-- 1. Notice titles, on the record and on its bell row: a mention ('<who> mentioned you in "<title>"'), an
--    invitation ('<who> invited you to <project> as <role>') and a waiting park ('<ref> is waiting for
--    <who>'s decision — <project>', '… for something only <who> can supply — …', '… for <who> — …'), each
--    behind whatever leads it: "Resolved — ", and the subject the delivery door puts first ("<ref> — ").
-- 2. A room's system line when a person joins or leaves it ('<who> joined; this room is now a group.').
-- 3. The comment a release posts on an issue it ships unverified ('… <who> decided, when pressing the
--    release, to ship it unverified: …').
--
-- The slot cannot hold a person's own name, since givenName read "another member" as no name, so
-- running each statement with the two words swapped restores every row it changed. A NOTICE says how
-- many rows each part re-rendered.
DO $$
DECLARE
  lead CONSTANT text := '^((?:.* — )?)';
  mention CONSTANT text := lead || 'Another member( mentioned you in ".*")$';
  invitation CONSTANT text := lead || 'Another member( invited you to .+ as [a-z_]+)$';
  waiting CONSTANT text := '^((?:.* — )?(?:[A-Za-z][A-Za-z0-9]{1,5}-[0-9]+|An issue) is waiting for (?:something only )?)another member((?:''s decision| can supply)? — .+)$';
  titles integer := 0;
  bell integer := 0;
  lines integer := 0;
  said integer := 0;
  n integer;
BEGIN
  UPDATE public.notifications SET title = regexp_replace(title, mention, '\1A member\2') WHERE title ~ mention;
  GET DIAGNOSTICS n = ROW_COUNT; titles := titles + n;
  UPDATE public.notifications SET title = regexp_replace(title, invitation, '\1A member\2') WHERE title ~ invitation;
  GET DIAGNOSTICS n = ROW_COUNT; titles := titles + n;
  UPDATE public.notifications SET title = regexp_replace(title, waiting, '\1a member\2') WHERE title ~ waiting;
  GET DIAGNOSTICS n = ROW_COUNT; titles := titles + n;

  UPDATE public.notification_deliveries SET title = regexp_replace(title, mention, '\1A member\2') WHERE title ~ mention;
  GET DIAGNOSTICS n = ROW_COUNT; bell := bell + n;
  UPDATE public.notification_deliveries SET title = regexp_replace(title, invitation, '\1A member\2') WHERE title ~ invitation;
  GET DIAGNOSTICS n = ROW_COUNT; bell := bell + n;
  UPDATE public.notification_deliveries SET title = regexp_replace(title, waiting, '\1a member\2') WHERE title ~ waiting;
  GET DIAGNOSTICS n = ROW_COUNT; bell := bell + n;

  UPDATE public.conversation_messages
     SET content = 'A member' || substr(content, length('Another member') + 1)
   WHERE role = 'system'
     AND content ~ '^Another member (joined|left); this room is now (a group|a one-to-one chat)\.$';
  GET DIAGNOSTICS lines = ROW_COUNT;

  UPDATE public.comments
     SET body = replace(
       body,
       ' and off the release''s roster. Another member decided, when pressing the release, to ship it unverified: ',
       ' and off the release''s roster. A member decided, when pressing the release, to ship it unverified: '
     )
   WHERE body LIKE '% and off the release''s roster. Another member decided, when pressing the release, to ship it unverified: %';
  GET DIAGNOSTICS said = ROW_COUNT;

  RAISE NOTICE '0396: "another member" re-rendered as "a member" in % notice title(s), % bell row title(s), % room line(s) and % release comment(s)',
    titles, bell, lines, said;
END $$;
