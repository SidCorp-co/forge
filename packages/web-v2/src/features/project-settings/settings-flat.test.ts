// ISS-1262 finding 6: the owner's rule, said three times, is flat sections with hairline dividers and
// hierarchy from type and whitespace, no card mosaic. A settings page that stacks `Card`s again fails
// here by name, so the rule outlives the pass that applied it.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FEATURES = resolve(process.cwd(), "src/features");

const SETTINGS_PAGES = [
  "project-settings/components/basics-tab.tsx",
  "project-settings/components/repo-tab.tsx",
  "project-settings/components/testing-tab.tsx",
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

/** Every class list in a source file: each string literal that could hold one. */
function classLists(source: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
}

/**
 * A container drawn as a box: all four sides bordered, or rounded and filled and padded. A flat page
 * rules its sections with a hairline on one side and takes its hierarchy from type and whitespace.
 * A pill, a fixed-size control and a code readout are not containers.
 */
function boxedContainer(classes: string): boolean {
  const t = classes.split(/\s+/).filter(Boolean);
  const rounded = t.some((x) => /^rounded-(sm|md|lg|xl|2xl)$/.test(x));
  const bordered = t.includes("border");
  const filled = t.some((x) => /^bg-(surface|sunken)/.test(x)) && t.some((x) => /^p[xy]?-/.test(x));
  const control = t.some((x) => /^h-\d+$/.test(x)) && t.some((x) => /^w-\d+$/.test(x));
  const exempt = control || t.includes("rounded-pill") || t.includes("font-mono");
  return (bordered || (rounded && filled)) && !exempt;
}

/** Each source file of a screen's own components, by path under `features/`. */
function componentFiles(dir: string): string[] {
  return readdirSync(resolve(FEATURES, dir))
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => `${dir}/${name}`);
}

const SCREEN_COMPONENTS = [
  ...new Set([...componentFiles("project-settings/components"), ...componentFiles("settings/components")]),
];

/** The `<Collapsible>` tags a source opens that are not flat: no `flat`, or `flat={false}`. */
function unflatDisclosures(source: string): number {
  const opened = source.match(/<Collapsible\b/g)?.length ?? 0;
  const flat = source.match(/<Collapsible\s+flat(?=\s|>|\/|=\{true\})/g)?.length ?? 0;
  return opened - flat;
}

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
    ["project-settings/components/testing-tab.tsx", "divide-y divide-line", 1],
    ["integrations/components/mcp-servers-panel.tsx", "border-t border-line", 1],
  ];

  it.each(RULED_ROWS)("%s rules each of its %#th row lists with a hairline and boxes none", (file, rule, owners) => {
    const source = readFileSync(resolve(FEATURES, file), "utf8");
    expect(source).not.toMatch(/<li[^>]*rounded-md border border-line|className="[^"]*rounded-md border border-line (px-3 py-2|p-3)/);
    expect(source.split(rule).length - 1).toBeGreaterThanOrEqual(owners);
  });
});
