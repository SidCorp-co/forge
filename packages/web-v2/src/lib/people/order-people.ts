// The one order every list of people takes, and the words that tell two unnamed people apart (ISS-1229 r28).

import { givenName, readerName } from "@forge/contracts/person-name";

export interface ListedPerson {
  userId: string | null | undefined;
  displayName: string | null | undefined;
  addedAt: string | null | undefined;
  key?: string | undefined;
}

const keyOf = (p: ListedPerson) => p.key ?? p.userId ?? "";

const NEVER = "\uffff";

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
    return (a.addedAt ?? NEVER).localeCompare(b.addedAt ?? NEVER) || keyOf(a).localeCompare(keyOf(b));
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

const addedDay = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
const addedTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

/**
 * What tells a person apart from the others in `everyone` who read the same name to this reader: the
 * day they were added, then the minute, then their place in the order added (ISS-1229 r24). Null
 * where nobody else reads like them, or where when they were added is not known.
 */
export function addedApart(
  person: ListedPerson,
  everyone: readonly ListedPerson[],
  viewerId?: string | null,
): string | null {
  if (!person.addedAt) return null;
  const base = (p: ListedPerson) => readerName(p.userId, viewerId, p.displayName).toLowerCase();
  const alike = everyone
    .filter((p) => p.addedAt && base(p) === base(person))
    .sort(
      (a, b) =>
        (a.addedAt as string).localeCompare(b.addedAt as string) || keyOf(a).localeCompare(keyOf(b)),
    );
  if (alike.length < 2) return null;
  const day = (p: ListedPerson) => addedDay(p.addedAt as string);
  const minute = (p: ListedPerson) => `${day(p)}, ${addedTime(p.addedAt as string)}`;
  if (alike.filter((p) => day(p) === day(person)).length < 2) return `added ${day(person)}`;
  const sameMinute = alike.filter((p) => minute(p) === minute(person));
  if (sameMinute.length < 2) return `added ${minute(person)}`;
  const place = sameMinute.findIndex((p) => keyOf(p) === keyOf(person));
  return `added ${minute(person)}, the ${ORDINALS[place] ?? `number ${place + 1}`}`;
}
