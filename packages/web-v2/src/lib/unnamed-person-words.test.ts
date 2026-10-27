// ISS-1229 r49, judge-146: a person with no display name was "A member" on their messages and "Another
// member" in Settings -> Account's hint, a room's people list and the room starter, because each place
// spelled the words itself. Every place now takes them from @forge/contracts/person-name; this reads the
// source of web, core and contracts for a place that spells the old words again.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { personName, UNNAMED_PERSON, UNNAMED_PERSON_AT_START } from "@forge/contracts/person-name";
import { describe, expect, it } from "vitest";
import { memberName } from "@/features/conversations/membership";

const PACKAGES = fileURLToPath(new URL("../../../", import.meta.url));
const ROOTS = ["web-v2/src", "core/src", "contracts/src"];

/** Lines whose "another member" means one more member, never a person's name. */
const COUNTING = new Map<string, RegExp>([
  ["web-v2/src/features/issues/activity-sentences.ts", /mentioned you and \$\{others === 1 \? "another member"/],
  ["web-v2/src/features/project-settings/components/runner-pools-section.tsx", /goes to another member\. When/],
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$|\.fixture\.ts$/.test(name) ? [path] : [];
  });
}

/** Each line of code that spells the old words, comments left out, and the counting lines it passed. */
function spellings(): { found: string[]; counting: number } {
  const found: string[] = [];
  let counting = 0;
  for (const root of ROOTS) {
    for (const path of sources(join(PACKAGES, root))) {
      const file = relative(PACKAGES, path);
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, at) => {
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
          if (!/\banother member\b/i.test(code)) return;
          if (COUNTING.get(file)?.test(code)) {
            counting += 1;
            return;
          }
          found.push(`${file}:${at + 1}: ${code}`);
        });
    }
  }
  return { found, counting };
}

describe("a person who gave no name", () => {
  it('is "a member", and "A member" opening a sentence or as a label', () => {
    expect(UNNAMED_PERSON).toBe("a member");
    expect(UNNAMED_PERSON_AT_START).toBe("A member");
    expect(personName(null, "start")).toBe("A member");
    expect(personName("  ", "inside")).toBe("a member");
  });

  it("is named in a room's people list as their messages are signed", () => {
    const person = {
      id: "p1",
      kind: "person" as const,
      userId: "u1",
      projectId: null,
      label: null,
      displayName: null,
      reachable: null,
      addedAt: "2026-10-27T04:19:00Z",
    };
    expect(memberName(person, "me", "start")).toBe("A member");
  });

  it("is never spelled another member by web, core or contracts code", () => {
    const { found, counting } = spellings();
    expect(found).toEqual([]);
    // The scan read the files that say "another member" as a count, so it reads the ones that would not.
    expect(counting).toBe(COUNTING.size);
  });
});
