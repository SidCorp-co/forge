// What a room's assistant may run with the `forge` CLI, and where a person does what it may not: the
// door that refuses a call and the card that tells the room read this one table (ISS-1229 r40).

export const ROOM_VERBS: readonly string[] = [
  'issue',
  'new',
  'comment',
  'attach',
  'next',
  'spec',
  'guide',
  'project',
  'knowledge',
];

export const ROOM_KNOWLEDGE_READS: readonly string[] = ['list', 'get', 'search'];

const DONE_IN_THE_APP: Readonly<Record<string, string>> = {
  advance: "A status is moved on the issue's page.",
};

export const DONE_AT_A_TERMINAL = 'That is done at a terminal.';

const HELP = new Set(['-h', '--help']);

export function roomOpens(verb: string, sub?: string): boolean {
  if (HELP.has(verb)) return true;
  if (!ROOM_VERBS.includes(verb)) return false;
  if (verb !== 'knowledge' || sub === undefined || HELP.has(sub)) return true;
  return ROOM_KNOWLEDGE_READS.includes(sub);
}

/** Where a person does an act a room does not open: in the app where it offers it, else at a terminal. */
export function whereItIsDone(verb: string): string {
  return DONE_IN_THE_APP[verb] ?? DONE_AT_A_TERMINAL;
}
