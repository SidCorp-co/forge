-- The box a work-state lease was taken from (fix/declared-run-is-the-holder). A master's claim
-- writes `issue_work_state.lease` for the run it declares, and that blob (forge-plugin's) names its
-- holder but not the box: so the move to awaiting_release, which the run holding the issue makes,
-- could not tell the declaring box from any other and refused it NOT_THE_HOLDER (adminhub-api ISS-8,
-- 2026-10-23). Core writes the device and token of the write that named the holder here, and keeps
-- them across writes that keep the holder. They are never composed into `sessionContext`
-- (`issue_session_context` reads `lease` alone): the plugin reads its lease back and compares it to
-- what it sent.
--
-- No row is backfilled: nothing recorded which box wrote a lease already live. Such a lease names no
-- box until its next write, so until then only a run session, or a holder of `releases.approve` or
-- `project.admin`, moves its issue to awaiting_release, as before this deploy.
--
-- ROLLBACK: drop the two columns; the guard then reads declared runs as holding from no box.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "issue_work_state" ADD COLUMN "lease_device_id" uuid REFERENCES "devices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issue_work_state" ADD COLUMN "lease_token_id" uuid REFERENCES "personal_access_tokens"("id") ON DELETE SET NULL;
