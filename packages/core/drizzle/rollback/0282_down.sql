-- Undo 0282_room_transcript_index (ISS-1090).
--
-- The index is derived: every row in these two tables was cut from
-- `conversation_messages`, which this does not touch. Dropping them loses no
-- retained content and the index is rebuildable from the transcript whenever
-- the tables come back.
DROP TABLE IF EXISTS "conversation_passages";
DROP TABLE IF EXISTS "conversation_index_state";
