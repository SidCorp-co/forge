// What tells two people apart who read the same name, said once for the web's lists and for core's
// sentences about them, so a refusal names an unnamed person as the Members list draws them (ISS-1421 r29).

import { readerName } from './person-name.js';

export interface ListedPerson {
  userId: string | null | undefined;
  displayName: string | null | undefined;
  addedAt: string | null | undefined;
  key?: string | undefined;
}

export const listedKey = (p: ListedPerson): string => p.key ?? p.userId ?? '';

const addedDay = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  );
const addedTime = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

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
        (a.addedAt as string).localeCompare(b.addedAt as string) ||
        listedKey(a).localeCompare(listedKey(b)),
    );
  if (alike.length < 2) return null;
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
