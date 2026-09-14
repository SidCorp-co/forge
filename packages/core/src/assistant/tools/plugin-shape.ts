/**
 * The chat door's shape read, run by the plugin's own reader.
 *
 * `forge new` and this door refuse the same body because they call the same
 * function: `shapeOf` in `plugin/src/tracker/issue-shape.mjs`, pinned as a
 * dependency. Nothing here holds a section, a heading or a threshold — a rule
 * decided in the server is the third reader ISS-1006 exists to remove.
 */

// cm:guard the reference is what carries `forge-plugin-shape.d.ts` into every program that compiles this file, and it is not redundant with core's own tsconfig: `@forge/contracts` reaches core through `@forge/core/public` and builds it under a tsconfig whose `include` is `src/**/*` of ITS OWN package, so the ambient declaration is absent there and the import falls to TS7016. Measured 2026-09-14 — `pnpm verify` stayed green and `pnpm test` failed at `@forge/contracts:build` (ISS-1006).
/// <reference path="./forge-plugin-shape.d.ts" />

import {
  type PluginShape,
  shapeOf,
  shapeRefusal,
} from 'forge-plugin/plugin/src/tracker/issue-shape.mjs';

/**
 * `everySection` is passed, so the CLI's light path does not reach this door.
 */
// cm:guard measured 2026-09-14: a body of `## Outcome` alone with `complexity: xs` earns 0 gaps without this flag and 4 with it. The light path is `forge new`'s convenience for a person typing five sections at a terminal — ISS-1267 states it is the CLI's method and not the tracker's rules — and a model pays no typing cost, so left on it would hand back the hole this door was closed to fix. `complexity` is in `CHAT_TOLERATED_DATA_KEYS`, so the model can set it.
const EVERY_SECTION = { everySection: true } as const;

/**
 * A body this reader cannot read at all, refused by name.
 */
// cm:guard refused BY NAME rather than read anyway: the plugin's heading matcher takes `^#{1,6}[ \t]+` and nothing else, so an html body whose sections are `<h2>` reads as having none — and refusing it for every section it actually carries names a problem the filing does not have. `descriptionFormat` is tolerated at this door, so the filing is reachable.
export const HTML_BODY_REFUSAL =
  'issue rejected: this door reads a markdown body. The filing named `descriptionFormat: "html"`, and the sections an issue owes are read from markdown headings (`## Outcome`), so an html body cannot be read against them at all. Re-send the same create with the body as markdown.';

export interface ChatFiling {
  readonly title: string;
  readonly body: string;
  readonly category: string | null;
  readonly complexity: string | null;
}

/**
 * Read a chat filing, and hand back the plugin's own refusal or null.
 */
// cm:guard the refusal is rendered by the PLUGIN's `shapeRefusal` and never composed here, so no wording a filer reads at this door was written on this side of the wire. A server-side string here would drift from the terminal's the first time either moved.
export function refuseChatFiling(filing: ChatFiling): string | null {
  return shapeRefusal(readChatFiling(filing));
}

/** The verdict itself, for a caller that wants the gaps rather than the prose. */
export function readChatFiling(filing: ChatFiling): PluginShape {
  return shapeOf(
    {
      title: filing.title,
      body: filing.body,
      kind: filing.category,
      complexity: filing.complexity,
    },
    EVERY_SECTION,
  );
}
