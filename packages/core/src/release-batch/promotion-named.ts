// ISS-1281 (FB-709): what the cut found when it read the promotion request it names from the source
// host, because the projection held none such across the promotion, and the sentence each refusal
// says of it. Pure: the read is `promotion-reread.ts`'s.

/** The named request as the host answered for it at the cut, or why it could not. */
export type NamedPromotionRead =
  /** The host answered, and its answer was written onto the projection. */
  | { number: number; label: string; outcome: 'read'; state: string; from: string; into: string }
  /** The host holds no change request with this number. */
  | { number: number; label: string; outcome: 'absent'; on: string }
  /** The host could not be read, so the projection may be behind it. */
  | { number: number; label: string; outcome: 'unread'; reason: string };

/** The sentence `RELEASE_PROMOTION_MISSING` ends on where no request was named, and the reread replaces. */
export const OPEN_PROMOTION =
  'Open it at a head judged on the branch work lands on, then cut again naming it as `promotion.request`: a request Forge has not recorded yet is read from the host at the cut.';

export function isNamedPromotionRead(v: unknown): v is NamedPromotionRead {
  const o = v as { outcome?: unknown; number?: unknown } | null;
  return (
    typeof o?.number === 'number' &&
    (o.outcome === 'read' || o.outcome === 'absent' || o.outcome === 'unread')
  );
}

/** What the host said of the named request, said so no refusal reads it as "none is open". */
export function namedPromotionSentence(read: NamedPromotionRead, across: string): string {
  const { label, number } = read;
  if (read.outcome === 'absent') {
    return `${label} is not on the host: ${read.on} holds no change request numbered ${number}. Open the promotion there, then cut again naming its number.`;
  }
  if (read.outcome === 'unread') {
    return `${label} is not in Forge's record of the host, and reading it from the host failed (${read.reason}), so that record may be stale and ${label} may well be open. Cut again once the host answers, or re-read it with \`POST /api/projects/:id/integrations/source/change-requests/${number}/refresh\`.`;
  }
  return `${label} was read from the host just now: it is ${read.state}, from \`${read.from}\` into \`${read.into}\`, so it is not a request ${across} that is open, or merged and not yet released.`;
}
