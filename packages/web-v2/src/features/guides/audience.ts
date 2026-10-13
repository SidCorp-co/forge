// The two readers the public documentation serves, and the door each one comes in by.
// The value is the `audience` a page declares; the words are the reader's own.

import { type Audience, DOOR_LABELS } from "@forge/contracts/guide-addresses";

export { AUDIENCES, type Audience, isAudience } from "@forge/contracts/guide-addresses";

interface Door {
  label: string;
  blurb: string;
  /** Said at the top of every page written for this reader. */
  notice: string;
}

export const DOORS: Record<Audience, Door> = {
  user: {
    label: DOOR_LABELS.user,
    blurb: "Ask for a change, read where it stands, and tell when it is done.",
    notice: "Written for people using Forge.",
  },
  agent: {
    label: DOOR_LABELS.agent,
    blurb: "The rules Forge's agents are held to, each also served as plain markdown with no credential.",
    notice:
      "Written for agents: a rule Forge's agents are held to, not a how-to for using Forge.",
  },
};

export const AGENT_SECTION = "Rules agents are held to";

export const ONE_CORPUS =
  "Forge's documentation is one set of pages — the same content, two ways in. Pick the door that sounds like you; search reaches every page behind both.";

/** One term per door, each finding a page behind its own door, short enough for a phone. */
export const SEARCH_EXAMPLES: ReadonlyArray<{ audience: Audience; term: string }> = [
  { audience: "user", term: "status" },
  { audience: "agent", term: "dependencies" },
];
