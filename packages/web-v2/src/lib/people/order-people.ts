// The one order every list of people takes, and the words that tell two unnamed people apart (ISS-1229 r28).

import { compareAdded, type ListedPerson } from "@forge/contracts/people-apart";
import { givenName } from "@forge/contracts/person-name";

export type { ListedPerson };

function rank(person: ListedPerson, viewerId: string | null | undefined): number {
  if (person.userId && person.userId === viewerId) return 0;
  return givenName(person.displayName) ? 1 : 2;
}

/** The reader first, then people with a name by that name, then people with none by when each was added. */
export function comparePeople(viewerId?: string | null) {
  return (a: ListedPerson, b: ListedPerson): number => {
    const byRank = rank(a, viewerId) - rank(b, viewerId);
    if (byRank !== 0) return byRank;
    if (rank(a, viewerId) === 1) {
      const byName = (givenName(a.displayName) ?? "").localeCompare(givenName(b.displayName) ?? "", undefined, {
        sensitivity: "base",
      });
      if (byName !== 0) return byName;
    }
    return compareAdded(a, b);
  };
}

export function orderPeople<T>(
  people: readonly T[],
  viewerId: string | null | undefined,
  listed: (person: T) => ListedPerson = (person) => person as unknown as ListedPerson,
): T[] {
  const compare = comparePeople(viewerId);
  return [...people].sort((a, b) => compare(listed(a), listed(b)));
}

// How two people who read alike are told apart is contracts', so core's sentences name a person as
// these lists do (ISS-1421 r29).
export { addedApart, listedAs } from "@forge/contracts/people-apart";
