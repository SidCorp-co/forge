// Who an issue's standing names as its owner (ISS-1068): its assignee, else whoever filed it, except
// an account of the retired steward, which owns no work. An unassigned issue the steward filed names
// no owner, and its standing says what it waits on (the master takes a draft on or drops it). Whether
// the creator is a steward account is read in the standing's own row (`standing-read.ts:issueRows`).

export function ownerIdOf(ids: {
  assignee: string | null;
  creator: string | null;
  creatorIsSteward: boolean;
}): string | null {
  if (ids.assignee) return ids.assignee;
  return ids.creator && !ids.creatorIsSteward ? ids.creator : null;
}
