// What tells two people apart who read the same name, said once for the web's lists and for core's
// sentences about them, so a refusal names an unnamed person as the Members list draws them (ISS-1421 r29).

import { personName, readerName } from './person-name.js';

export interface ListedPerson {
  userId: string | null | undefined;
  displayName: string | null | undefined;
  addedAt: string | null | undefined;
  key?: string | undefined;
  /** Where the list that holds this person serves them; a room serves its opener first (ISS-1229 r45). */
  place?: number | undefined;
}

export const listedKey = (p: ListedPerson): string => p.key ?? p.userId ?? '';

const NEVER = '\uffff';

/** The one order of people by when each was added: the moment, then the place served, then the key. */
export function compareAdded(a: ListedPerson, b: ListedPerson): number {
  return (
    (a.addedAt ?? NEVER).localeCompare(b.addedAt ?? NEVER) ||
    (a.place ?? Number.MAX_SAFE_INTEGER) - (b.place ?? Number.MAX_SAFE_INTEGER) ||
    listedKey(a).localeCompare(listedKey(b))
  );
}

const addedDay = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  );
const addedTime = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

/**
 * What tells a person apart from others who gave the same name: the day, the minute, then their place
 * in the order added, worked out over all of them, reader included, so the words mean one person to
 * every reader (ISS-1229 r44). Null for the reader, or where this reader sees nobody else alike.
 */
export function addedApart(
  person: ListedPerson,
  everyone: readonly ListedPerson[],
  viewerId?: string | null,
): string | null {
  if (!person.addedAt || (person.userId && person.userId === viewerId)) return null;
  const base = (p: ListedPerson) => personName(p.displayName).toLowerCase();
  const alike = everyone.filter((p) => p.addedAt && base(p) === base(person)).sort(compareAdded);
  if (alike.filter((p) => !p.userId || p.userId !== viewerId).length < 2) return null;
  const day = (p: ListedPerson) => addedDay(p.addedAt as string);
  const minute = (p: ListedPerson) => `${day(p)}, ${addedTime(p.addedAt as string)}`;
  if (alike.filter((p) => day(p) === day(person)).length < 2) return `added ${day(person)}`;
  const sameMinute = alike.filter((p) => minute(p) === minute(person));
  if (sameMinute.length < 2) return `added ${minute(person)}`;
  const place = sameMinute.findIndex((p) => listedKey(p) === listedKey(person));
  return `added ${minute(person)}, the ${ORDINALS[place] ?? `number ${place + 1}`}`;
}

/** A person as a Members list row names them to `viewerId`: their name, and what tells them apart. */
export function listedAs(
  person: ListedPerson,
  everyone: readonly ListedPerson[],
  viewerId?: string | null,
): string {
  const name = readerName(person.userId, viewerId, person.displayName);
  const apart = addedApart(person, everyone, viewerId);
  return apart ? `${name} (${apart})` : name;
}
