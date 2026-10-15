// The three readers the public documentation serves, and the door each one comes in by.
// The value is the `audience` a page declares; the words are the reader's own.
import type { HelpDoc } from "@/features/docs/help-content.generated";
import { plainText } from "@/features/docs/reader";

export const AUDIENCES = ["user", "assistant-setup", "agent"] as const;
export type Audience = (typeof AUDIENCES)[number];

export function isAudience(value: string): value is Audience {
  return (AUDIENCES as readonly string[]).includes(value);
}

/** The doors of help pages, bundled into the web build and so open while core is down. */
export const BUNDLED_AUDIENCES: readonly Audience[] = ["user", "assistant-setup"] satisfies HelpDoc["audience"][];

export interface Door {
  label: string;
  blurb: string;
  /** Said at the top of every page written for this reader. */
  notice: string;
  /** Who comes in by this door, as the header names them. */
  reader: string;
  /** Whose pages these are, as a search over them says. */
  pages: string;
}

export const DOORS: Record<Audience, Door> = {
  user: {
    label: "I use Forge",
    blurb: "Ask for a change, read where it stands, and tell when it is done.",
    notice: "Written for people using Forge.",
    reader: "people using Forge",
    pages: "people",
  },
  "assistant-setup": {
    label: "I'm connecting an AI assistant",
    blurb: "Ask Forge things in your own words from Claude, Cursor or another app you already use.",
    notice: "Written for people connecting an AI assistant to Forge.",
    reader: "people connecting an assistant",
    pages: "people",
  },
  agent: {
    label: "I'm an agent or a script",
    blurb: "The rules Forge's agents are held to, each also served as plain markdown with no credential.",
    notice:
      "Written for agents: a rule Forge's agents are held to, not a how-to for using Forge.",
    reader: "agents",
    pages: "agents",
  },
};

/** The one name of the public surface, and what its header says under it. */
export const SITE_NAME = "Forge documentation";

/** The tab's title for a door, page or refusal, a page title's code marks left out. */
export function documentTitle(subject: string | null): string {
  return subject ? `${plainText(subject)} — ${SITE_NAME}` : SITE_NAME;
}

/** The doors a page offers: every one while core's guide index answers, the bundled ones while it
 *  does not. The header, the search and the outage sentences each read what they say from it. */
export function openDoors(indexDown: boolean): readonly Audience[] {
  return indexDown ? BUNDLED_AUDIENCES : AUDIENCES;
}

function listed(words: readonly string[]): string {
  if (words.length < 3) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

export function readersOf(doors: readonly Audience[]): string {
  return listed(doors.map((a) => DOORS[a].reader));
}

export function pagesOf(doors: readonly Audience[]): string {
  return `the pages for ${listed([...new Set(doors.map((a) => DOORS[a].pages))])}`;
}

export function siteCaption(doors: readonly Audience[]): string {
  return `For ${readersOf(doors)}.`;
}

export function searchLabel(doors: readonly Audience[]): string {
  return doors.length === AUDIENCES.length ? "Search every page" : `Search ${pagesOf(doors)}`;
}

export const INDEX_PATH = "/guides";

export function doorHref(audience: Audience): string {
  return `${INDEX_PATH}?for=${audience}`;
}

export const AGENT_SECTION = "Rules agents are held to";

export const ONE_CORPUS =
  "Forge's documentation is one set of pages — the same content, three ways in. Pick the door that sounds like you; search reaches every page behind all three.";

/** One term per door, each finding a page behind its own door, short enough for a phone. */
export const SEARCH_EXAMPLES: ReadonlyArray<{ audience: Audience; term: string }> = [
  { audience: "user", term: "status" },
  { audience: "assistant-setup", term: "Claude" },
  { audience: "agent", term: "dependencies" },
];
