// A schedule's row reads its cadence in words, never its raw cron (ISS-1072): every N minutes, hourly,
// daily or on a weekday at a time; a cron no phrase fits reads as a custom cadence, the cron itself
// kept for the tooltip and the schedule's own page.
// @direct-test-of packages/web-v2/src/features/automation/cadence.ts
// @direct-test-of packages/web-v2/src/features/automation/components/schedule-views.tsx

import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { cadenceOf } from "./cadence";
import { scheduleRow } from "./components/schedule-views";
import type { ScheduleStanding } from "./types";

const t = productCopy();
const time = { age: () => "2d", dateTime: () => "06/11/2026, 09:00" } as never;

describe("a schedule's cadence", () => {
  it.each([
    ["*/15 * * * *", "Every 15 min"],
    ["0 * * * *", "Hourly"],
    ["30 2 * * *", "Daily 02:30"],
    ["0 2 * * 1", "Mondays 02:00"],
    ["0 9 * * 1-5", "Weekdays 09:00"],
    ["7 3 1 * *", "Custom"],
  ])("%s reads %s", (cron, words) => {
    expect(cadenceOf(cron, t)).toBe(words);
  });
});

describe("a schedule's row", () => {
  const s = {
    id: "s1",
    name: "Beta port",
    kind: "agent",
    cron: "*/15 * * * *",
    state: "on",
    targetProjectSlug: null,
    lastFire: null,
    nextFireAt: null,
    owner: { id: "u1", name: "Lan" },
    waitingOn: { kind: "none", who: "Nobody", act: "", rule: "", ref: null, dueAt: null },
  } as unknown as ScheduleStanding;

  it("leads with the schedule's name and reads its cadence in words, the cron only in the tooltip", () => {
    const row = scheduleRow((id) => `/s/${id}`, { t, language: "en", time })(s);
    expect(row.title).toBe("Beta port");
    expect(row.keyLabel).toBeUndefined();
    const facts = JSON.stringify(row.facts);
    expect(facts).toContain("Every 15 min");
    expect(facts).not.toContain('"children":"*/15 * * * *"');
  });
});
