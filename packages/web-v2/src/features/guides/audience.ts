// The three readers the public documentation serves, and the door each one comes in by.
// The value is the `audience` a page declares; the words are the reader's own.

export const AUDIENCES = ["user", "assistant-setup", "agent"] as const;
export type Audience = (typeof AUDIENCES)[number];

export function isAudience(value: string): value is Audience {
  return (AUDIENCES as readonly string[]).includes(value);
}

export interface Door {
  label: string;
  blurb: string;
  /** Said at the top of every page written for this reader. */
  notice: string;
}

export const DOORS: Record<Audience, Door> = {
  user: {
    label: "I use Forge",
    blurb: "Ask for a change, read where it stands, and tell when it is done.",
    notice: "Written for people using Forge.",
  },
  "assistant-setup": {
    label: "I'm connecting an AI assistant",
    blurb: "Ask Forge things in your own words from Claude, Cursor or another app you already use.",
    notice: "Written for people connecting an AI assistant to Forge.",
  },
  agent: {
    label: "I'm an agent or a script",
    blurb: "The rules Forge's agents are held to, each also served as plain markdown with no credential.",
    notice:
      "Written for agents: a rule Forge's agents are held to, not a how-to for using Forge.",
  },
};

export const AGENT_SECTION = "Rules agents are held to";

export const ONE_CORPUS =
  "Forge's documentation is one set of pages — the same content, three ways in. Pick the door that sounds like you; search reaches every page behind all three.";

/** One term per door, each finding a page behind its own door, short enough for a phone. */
export const SEARCH_EXAMPLES: ReadonlyArray<{ audience: Audience; term: string }> = [
  { audience: "user", term: "status" },
  { audience: "assistant-setup", term: "Claude" },
  { audience: "agent", term: "dependencies" },
];
