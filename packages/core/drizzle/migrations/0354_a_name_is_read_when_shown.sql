-- ISS-1229 r25 — the master's ruling on judge-72's finding: a room message stored its speaker's name as
-- it stood when they spoke, so a rename never reached their old messages, and messages sent before
-- display names existed stored the speaker's email address, which core served as their name. A Forge
-- person's message now stores no name; core reads it from the person's row whenever the room is read.
--
-- 1. A message nobody is linked to whose label is an address is linked to the one account holding that
--    address, and its label dropped. Where no single account holds it, the deploy aborts naming the
--    message: an address cannot be served as a name, and a guess at whose it is would be a lie.
-- 2. The label of every message a Forge person wrote in a web room is dropped, and so is any label that
--    holds an address. A transport's own handle for a speaker (Rocket.Chat's username) is kept: the
--    drain addresses that person by it on their transport.
-- 3. A CHECK refuses an address as a label from here on.
--
-- Rollback: ALTER TABLE conversation_messages DROP CONSTRAINT
-- conversation_messages_label_holds_no_address. The dropped labels do not come back; each name is read
-- from its person, which is the point of the ruling.
DO $$
DECLARE
  linked integer;
  dropped integer;
  stray record;
BEGIN
  WITH holder AS (
    SELECT m.id, min(u.id::text)::uuid AS user_id, count(u.id) AS holders
      FROM conversation_messages m
      JOIN users u ON lower(u.email) = lower(btrim(m.author_label))
     WHERE m.author_user_id IS NULL
       AND m.author_label ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
     GROUP BY m.id
  )
  UPDATE conversation_messages m
     SET author_user_id = holder.user_id, author_label = NULL
    FROM holder
   WHERE holder.id = m.id AND holder.holders = 1;
  GET DIAGNOSTICS linked = ROW_COUNT;

  SELECT m.id, m.conversation_id, m.seq INTO stray
    FROM conversation_messages m
   WHERE m.author_user_id IS NULL
     AND m.author_label ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
   ORDER BY m.created_at, m.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0354: message % (seq % in conversation %) names its speaker by an email address that no single account holds, so it can be neither linked to a person nor shown by that address; link it to its author (UPDATE conversation_messages SET author_user_id = <the author''s user id>, author_label = NULL WHERE id = %) or clear its label, then deploy again',
      stray.id, stray.seq, stray.conversation_id, stray.id;
  END IF;

  UPDATE conversation_messages m
     SET author_label = NULL
    FROM conversations c
   WHERE c.id = m.conversation_id
     AND m.author_label IS NOT NULL
     AND m.author_user_id IS NOT NULL
     AND ((c.adapter = 'web' AND m.role = 'user')
          OR m.author_label ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}');
  GET DIAGNOSTICS dropped = ROW_COUNT;

  RAISE NOTICE '0354: % stored speaker label(s) dropped, each name now read from its person; % message(s) named by an address linked to the account holding it',
    dropped, linked;
END $$;
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_label_holds_no_address" CHECK ("conversation_messages"."author_label" IS NULL OR "conversation_messages"."author_label" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}');
