-- ISS-187: a kernel move records the credential it was made with and the person that credential
-- acts for, and a token records whom it was handed to act for.
ALTER TABLE "personal_access_tokens" ADD COLUMN IF NOT EXISTS "on_behalf_of" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "kernel_transitions" ADD COLUMN IF NOT EXISTS "actor_token_id" uuid;--> statement-breakpoint
ALTER TABLE "kernel_transitions" ADD COLUMN IF NOT EXISTS "actor_on_behalf_of" uuid;--> statement-breakpoint
-- Every approval became token-explicit: a token holds one only where its grant names it. An agent's
-- live credentials name the explicit permissions its memberships grant, as a credential minted from
-- now on does (`orgs/agent-fence.ts:agentCredentialGrant`); a grant naming no route group keeps its
-- whole reach as '*'.
WITH explicit AS (
  SELECT pm.user_id, array_agg(DISTINCT g) AS names
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id AND u.kind = 'agent'
    CROSS JOIN LATERAL unnest(pm.grants) AS g
   WHERE g IN (
     'questionnaires.answer', 'onboarding.request', 'charter.write', 'commitments.write',
     'feedback.redact', 'comments.moderate',
     'requirements.approve', 'mockups.approve', 'suggestions.approve', 'workflow-designs.approve',
     'contracts.approve', 'feedback.approve', 'releases.approve', 'plans.approve'
   )
   GROUP BY pm.user_id
)
UPDATE "personal_access_tokens" t
   SET permissions = ARRAY(
     SELECT DISTINCT p FROM unnest(
       CASE WHEN COALESCE(cardinality(t.permissions), 0) = 0 THEN ARRAY['*']::text[] ELSE t.permissions END
       || e.names
     ) AS p
   )
  FROM explicit e
 WHERE t.user_id = e.user_id
   AND t.revoked_at IS NULL
   AND (t.expires_at IS NULL OR t.expires_at > now());
