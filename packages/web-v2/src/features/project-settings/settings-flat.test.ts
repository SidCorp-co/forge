// ISS-1262 finding 6: the owner's rule, said three times, is flat sections with hairline dividers and
// hierarchy from type and whitespace, no card mosaic. A settings page that stacks `Card`s again fails
// here by name, so the rule outlives the pass that applied it.

import { readFileSync } from "node:fs";
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

describe("the settings pages are flat", () => {
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
