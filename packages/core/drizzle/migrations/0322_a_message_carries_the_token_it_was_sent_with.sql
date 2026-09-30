-- A person's message records the access token it was sent with, where they reached Forge with one
-- rather than a browser session, so the turn answering it is bounded by that token's grant (ISS-17).
-- Existing rows keep null, which is what a browser-session message is: a turn answering one is
-- bounded by the author's role alone, as every turn now is. No foreign key: a token row that is
-- gone must refuse the turn, where `ON DELETE SET NULL` would widen it. Rollback is dropping the
-- column.
ALTER TABLE "conversation_messages" ADD COLUMN "author_token_id" uuid;
