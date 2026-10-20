// ISS-1229 r24, the master's ruling: the reader reads "You" wherever a person is named to them, and
// their own avatar never wears the initials of an unnamed member. `readerName` / `readerInitials`
// tell the reader apart; `personName` / `personInitials` / `personChoice` cannot, so every file still calling them
// (and the issue page's `initials` wrapper) is named here with why the person it names is never the
// reader, or is told apart before the call, and with how many calls that reason covers.
// A new call, in a new file or a listed one, fails this until it is routed through the reader
// helpers or its reason is extended to it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const WHY_NOT_THE_READER: Record<string, { calls: number; why: string }> = {
  "features/conversations/membership.ts": {
    calls: 4,
    why: "memberName answers You for the reader first; the rest name people being added (never the reader, who is in the room) or readers an agent would put out",
  },
  "features/conversations/components/start-conversation.tsx": {
    calls: 1,
    why: "the people a new room could take in, which never lists the reader",
  },
  "features/conversations/components/add-person-dialog.tsx": {
    calls: 2,
    why: "the people a room could still take in, which never lists the reader, who is in it",
  },
  "features/integrations/connection-space.ts": {
    calls: 1,
    why: "the reader's own credential reads Personal before a person is named",
  },
  "features/integrations/providers/github/reuse.ts": {
    calls: 1,
    why: "a person-owned App the reader cannot bind, so its owner is somebody else",
  },
  "features/settings/components/account-tab.tsx": {
    calls: 2,
    why: "the fallback words themselves, telling the reader what others read them as",
  },
  "features/issues/activity-sentences.ts": {
    calls: 2,
    why: "actorOf answers You for the reader first",
  },
  "features/issues/derive.ts": {
    calls: 3,
    why: "memberLabel, creatorChoice and creatorInitialsOf tell the reader apart first; `initials` is the wrapper a device's name takes",
  },
  "features/issues/components/comment-thread.tsx": {
    calls: 1,
    why: "the author and the via line tell the reader apart first; `initials` takes a device's name only",
  },
};

const CALL = /\b(personName|personInitials|personChoice|initialsOf|initials)\(/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("every place that names a person to the reader", () => {
  const root = join(import.meta.dirname, "..");
  const calls = Object.fromEntries(
    sources(root)
      .map((file) => [relative(root, file).split("\\").join("/"), readFileSync(file, "utf8").match(CALL)?.length ?? 0] as const)
      .filter(([, n]) => n > 0),
  );

  it("tells the reader apart, or says why the person each call names is never the reader", () => {
    const listed = Object.fromEntries(Object.entries(WHY_NOT_THE_READER).map(([file, { calls: n }]) => [file, n]));
    expect(calls).toEqual(listed);
  });
});
