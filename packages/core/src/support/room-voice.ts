// What a room's agent may be handed to say (ISS-1483). The person knows one voice, the agent's: a
// sentence a read hands the agent to relay never names the project's master, a team or a hand-off,
// because the agent repeats what it is handed (dev.857 and dev.858 each found one more such sentence).
// So a wait that is delivery work is worded at its source as what is waiting and for how long, and a
// person is named only where one owes the act. An instruction about an act the agent makes
// (`support.ask_master`) is not a sentence to say and stays where it is taught.

/** The delivery work's own name on a page (`standing.who.master`, `standing.who.projectMaster`): never said to a room. */
export const isDeliveryWork = (who: string): boolean => /\bmaster\b/i.test(who);

/** Stands in the owner's place where the act is delivery work: no name, no person. */
export const NO_PERSON = 'no person';

/** What a sentence the agent relays must never hold: a master, a team, a hand-off or a restart. */
export const NAMES_THE_HAND =
  /\bmasters?\b|\bteams?\b|\bhand-?(?:ed|s)?[ -]?(?:off|on|over)\b|\brestart/i;
