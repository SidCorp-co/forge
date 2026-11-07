// Who an issue's standing names as its owner (ISS-1068): its assignee, else whoever filed it, except
// an account of the retired steward, which owns no work. An unassigned issue the steward filed names
// no owner, and its standing says what it waits on (the master takes a draft on or drops it). Whether
// the creator is a steward account is read in the standing's own row (`standing-read.ts:issueRows`).
// One filed from a box is owned by the person who owns the box, so the list names a person, never
// the handle of the project's agent that filed it (ISS-1072). One an agent account filed from no box
// is owned by nobody: no person owns a project's agent account, so it reads Unassigned rather than
// the agent's handle (ISS-1072 round 2).

export function ownerIdOf(ids: {
  assignee: string | null;
  creator: string | null;
  creatorIsSteward: boolean;
  /** The creator is an agent account (`users.kind = 'agent'`), which owns no work of its own. */
  creatorIsAgent: boolean;
  /** The person who owns the box it was filed from (`devices.owner_id`), where it was filed from one. */
  boxOwner: string | null;
}): string | null {
  if (ids.assignee) return ids.assignee;
  if (!ids.creator || ids.creatorIsSteward) return null;
  if (ids.boxOwner) return ids.boxOwner;
  return ids.creatorIsAgent ? null : ids.creator;
}
