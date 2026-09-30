-- ISS-1317 — a project's agent account is shown under its handle.
--
-- `conversations/handles.ts` minted a project's agent account with no
-- display_name, so every reader that labels an author fell back to the
-- synthesized `<handle>.<hex>@agents.forge.invalid` address. The wedge net now
-- authors its reset comments as that account on every project, so the address
-- is what a person reads on the thread. From this change on the mint writes the
-- handle as the label; this fills the accounts minted before it.
--
-- Only a NULL label is filled, so a label an org admin or anybody else set is
-- left as it is and a second run finds nothing to fill. The handle comes from
-- the account's organization membership, and an account with more than one
-- membership is skipped rather than guessed at: a project's agent account
-- belongs to one project and so to one organization. No statement reverses it
-- exactly, because an agent an org admin created carries the same label by
-- design; the state it replaces is the one that rendered the address.
UPDATE users AS u
   SET display_name = m.handle
  FROM organization_members AS m
 WHERE m.user_id = u.id
   AND u.kind = 'agent'
   AND u.display_name IS NULL
   AND m.handle IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM organization_members AS other
      WHERE other.user_id = u.id AND other.org_id <> m.org_id
   );
