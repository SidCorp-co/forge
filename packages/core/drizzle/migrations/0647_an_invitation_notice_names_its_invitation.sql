-- An invitation's notice names its invitation (ISS-1188). The bell's badge counted every open
-- `invitation_received` notice while its list showed the invitations still pending instead, so a
-- notice whose invitation was accepted, declined, revoked, replaced or expired was counted and shown
-- nowhere. Core now writes the notice with `resolution_key` = 'invitation:' || the invitation's
-- stored digest, and a notice counts only while the invitation it names is pending
-- (`packages/core/src/notifications/read.ts:stillTrue`).
--
-- A notice written before names no invitation, so it stops counting with nothing written to it:
-- that is what ends the rows already stranded. This names the one older notice per invitation still
-- pending, the newest its invitee was sent, so that invitation keeps counting once until it is
-- answered or expires. Re-running it finds nothing left to name.
--
-- ROLLBACK: none kept; a named notice reads as before while its invitation is pending.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
UPDATE "notifications" n
   SET "resolution_key" = 'invitation:' || named."token_hash"
  FROM (
    SELECT DISTINCT ON (pi."token_hash") pi."token_hash", r."id"
      FROM "project_invitations" pi
      JOIN "users" u ON lower(u."email") = lower(pi."email")
      JOIN "notification_deliveries" d ON d."user_id" = u."id" AND d."resolved_notice" = false
      JOIN "notification_delivery_members" dm ON dm."delivery_id" = d."id"
      JOIN "notifications" r ON r."id" = dm."notification_id"
     WHERE r."type" = 'invitation_received'
       AND r."resolution_key" IS NULL
       AND r."project_id" = pi."project_id"
       AND pi."accepted_at" IS NULL
       AND pi."dismissed_at" IS NULL
       AND pi."expires_at" > now()
     ORDER BY pi."token_hash", r."created_at" DESC, r."id"
  ) named
 WHERE n."id" = named."id" AND n."resolution_key" IS NULL;
