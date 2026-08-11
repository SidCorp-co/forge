-- ISS-678 — lease column so `drainOutboxOnce` can claim a batch in a short
-- transaction, release the connection, then emit hooks with none open.
ALTER TABLE "pipeline_outbox" ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz;
