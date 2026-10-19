// ISS-1262 finding 6: the owner's rule, said three times, is flat sections with hairline dividers and
// hierarchy from type and whitespace, no card mosaic. A settings page that stacks `Card`s again fails
// here by name, so the rule outlives the pass that applied it.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { boxedContainer, classLists } from "@/test-support/flat-rule";

const FEATURES = resolve(process.cwd(), "src/features");

const SETTINGS_PAGES = [
  "project-settings/components/basics-tab.tsx",
  "project-settings/components/shape-tab.tsx",
  "project-settings/components/shape-sections.tsx",
  "project-settings/components/environment-blocks.tsx",
  "project-settings/components/release-section.tsx",
  "project-settings/components/pipeline-tab.tsx",
  "project-settings/components/memory-tab.tsx",
  "project-settings/components/labels-tab.tsx",
  "project-settings/components/modules-tab.tsx",
  "project-settings/components/members-tab.tsx",
  "project-settings/components/integrations-tab.tsx",
  "project-settings/components/advanced-tab.tsx",
  "runners/components/project-runners-screen.tsx",
  "integrations/components/project-integrations-panel.tsx",
  "integrations/components/mcp-servers-panel.tsx",
  "integrations/components/connection-group.tsx",
  "integrations/providers/github/section.tsx",
  "integrations/providers/coolify/section.tsx",
  "integrations/providers/sentry/section.tsx",
  "integrations/providers/postman/section.tsx",
  "integrations/providers/epodsystem/section.tsx",
  "settings/components/account-tab.tsx",
  "settings/components/assistant-preferences-card.tsx",
  "settings/components/notifications-tab.tsx",
  "settings/components/mcp-tab.tsx",
];

/** Each source file under a directory of `features/`, by path under `features/`, tests left out. */
function componentFiles(dir: string): string[] {
  return readdirSync(resolve(FEATURES, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return componentFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

/** The two settings screens' own components, the project Runners tab, and every Integrations component. */
const SCREEN_COMPONENTS = [
  ...new Set([
    ...componentFiles("project-settings/components"),
    ...componentFiles("settings/components"),
    ...componentFiles("integrations"),
    "runners/components/project-runners-screen.tsx",
  ]),
];

/** The `<Collapsible>` tags a source opens that are not flat: no `flat`, or `flat={false}`. */
function unflatDisclosures(source: string): number {
  const opened = source.match(/<Collapsible\b/g)?.length ?? 0;
  const flat = source.match(/<Collapsible\s+flat(?=\s|>|\/|=\{true\})/g)?.length ?? 0;
  return opened - flat;
}

describe("the detector of a boxed container", () => {
  it.each([
    ["rounded-lg border border-line bg-surface p-3", true],
    ["flex flex-col gap-3 rounded-md border border-subtle p-3", true],
    ["rounded-md bg-sunken px-3 py-2", true],
    ["border border-line p-4", true],
    ["border-t border-line pt-3", false],
    ["divide-y divide-line border-y border-line", false],
    ["border-b border-line pb-2 text-muted", false],
    ["rounded-pill border border-line px-2", false],
    ["inline-flex h-6 w-6 rounded-md border border-line", false],
    ["inline-flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5", false],
    ["overflow-x-auto font-mono rounded-md border border-line p-3", false],
  ])("reads %j as boxed: %s", (classes, boxed) => {
    expect(boxedContainer(classes)).toBe(boxed);
  });
});

describe("the detector of a boxed disclosure", () => {
  it.each([
    ['<Collapsible flat title="Stage">x</Collapsible>', 0],
    ["<Collapsible\n  flat\n  title={t}\n>x</Collapsible>", 0],
    ["<Collapsible flat={true} title={t}>x</Collapsible>", 0],
    ['<Collapsible title="Stage">x</Collapsible>', 1],
    ['<Collapsible flat={false} title="Stage">x</Collapsible>', 1],
    ['<Collapsible flat={on} title="Stage">x</Collapsible>', 1],
    ['<Collapsible flatten title="Stage">x</Collapsible>', 1],
    ['<Collapsible title="a" flat>x</Collapsible>', 1],
  ])("reads %j as %i not flat", (source, notFlat) => {
    expect(unflatDisclosures(source)).toBe(notFlat);
  });
});

describe("the settings pages are flat", () => {
  it.each(SCREEN_COMPONENTS)("%s draws no box around a section", (file) => {
    const boxes = classLists(readFileSync(resolve(FEATURES, file), "utf8")).filter(boxedContainer);
    expect(boxes).toEqual([]);
  });

  it.each(SCREEN_COMPONENTS)("%s discloses a section flat", (file) => {
    expect(unflatDisclosures(readFileSync(resolve(FEATURES, file), "utf8"))).toBe(0);
  });

  it.each(SETTINGS_PAGES)("%s stacks no Card", (file) => {
    const source = readFileSync(resolve(FEATURES, file), "utf8");
    expect(source).not.toMatch(/<Card[\s>]|<CardContent|<CardHeader/);
  });

  const RULED_ROWS: Array<[file: string, rule: string, owners: number]> = [
    ["project-settings/components/members-tab.tsx", "divide-y divide-line", 2],
    ["project-settings/components/labels-tab.tsx", "divide-y divide-line", 1],
    ["project-settings/components/modules-tab.tsx", "divide-y divide-line", 1],
    ["project-settings/components/environment-blocks.tsx", "divide-y divide-line", 2],
    ["integrations/components/mcp-servers-panel.tsx", "border-t border-line", 1],
  ];

  it.each(RULED_ROWS)("%s rules each of its %#th row lists with a hairline and boxes none", (file, rule, owners) => {
    const source = readFileSync(resolve(FEATURES, file), "utf8");
    expect(source).not.toMatch(/<li[^>]*rounded-md border border-line|className="[^"]*rounded-md border border-line (px-3 py-2|p-3)/);
    expect(source.split(rule).length - 1).toBeGreaterThanOrEqual(owners);
  });
});
