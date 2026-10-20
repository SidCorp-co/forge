// ISS-1229 r24, the master's ruling: the reader reads "You" wherever a person is named to them, and
// their own avatar never wears the initials of an unnamed member. `readerName` / `readerInitials`
// tell the reader apart; `personName` / `personInitials` / `personChoice` cannot, so every file still calling them
// (and the issue page's `initials` wrapper) is named here with why the person it names is never the
// reader, or is told apart before the call.
// A new caller fails this until it is routed through the reader helpers or given its reason.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const WHY_NOT_THE_READER: Record<string, string> = {
  "features/conversations/membership.ts":
    "memberName answers You for the reader first; the rest name people being added (never the reader, who is in the room) or readers an agent would put out",
  "features/conversations/components/start-conversation.tsx":
    "the people a new room could take in, which never lists the reader",
  "features/conversations/components/add-person-dialog.tsx":
    "the people a room could still take in, which never lists the reader, who is in it",
  "features/integrations/connection-space.ts":
    "the reader's own credential reads Personal before a person is named",
  "features/integrations/providers/github/reuse.ts":
    "a person-owned App the reader cannot bind, so its owner is somebody else",
  "features/settings/components/account-tab.tsx":
    "the fallback words themselves, telling the reader what others read them as",
  "features/issues/activity-sentences.ts": "actorOf answers You for the reader first",
  "features/issues/derive.ts":
    "memberLabel, creatorChoice and creatorInitialsOf tell the reader apart first; `initials` is the wrapper a device's name takes",
  "features/issues/components/comment-thread.tsx":
    "the author and the via line tell the reader apart first; `initials` takes a device's name only",
};

const CALL = /\b(personName|personInitials|personChoice|initialsOf|initials)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("every place that names a person to the reader", () => {
  const root = join(import.meta.dirname, "..");
  const callers = sources(root)
    .filter((file) => CALL.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file).split("\\").join("/"));

  it("tells the reader apart, or says why the person it names is never the reader", () => {
    expect(callers.filter((file) => !(file in WHY_NOT_THE_READER))).toEqual([]);
  });

  it("names no file that no longer calls them", () => {
    expect(Object.keys(WHY_NOT_THE_READER).filter((file) => !callers.includes(file))).toEqual([]);
  });
});
