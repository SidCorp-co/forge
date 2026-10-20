// What a person is called wherever another member reads it: the name they gave, never their address
// (ISS-1229). Only Settings → Members, invitations and a picker (personChoice) show an address.

export const UNNAMED_PERSON = 'another member';
export const UNNAMED_PERSON_AT_START = 'Another member';

export const ADDRESS_PATTERN = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';

export function carriesAnAddress(text: string): boolean {
  return new RegExp(ADDRESS_PATTERN).test(text);
}

/** The display name, trimmed, where it names somebody; null where it is blank or holds an address. */
export function givenName(displayName: string | null | undefined): string | null {
  const given = displayName?.trim();
  return given && !carriesAnAddress(given) ? given : null;
}

export function personName(
  displayName: string | null | undefined,
  at: 'inside' | 'start' = 'inside',
): string {
  return givenName(displayName) ?? (at === 'start' ? UNNAMED_PERSON_AT_START : UNNAMED_PERSON);
}

/** One letter from each of the first two words, else the first two letters. */
export function personInitials(displayName: string | null | undefined): string {
  const words = personName(displayName).split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((w) => w.charAt(0))
          .join('')
      : (words[0] ?? '').slice(0, 2);
  return letters.toUpperCase();
}

export function personChoice(
  displayName: string | null | undefined,
  email: string,
): { label: string; detail: string } {
  return { label: personName(displayName, 'start'), detail: email.trim() };
}
