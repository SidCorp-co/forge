import { verbatim } from "@forge/contracts/said";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import { AT, STATUS } from "@/test/project-status";
import { StatusReport } from "./status-report";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

// hop /status, 2026-10-08: 25 of its lines were texts agents wrote in English, quoted with nothing
// saying so. The page reads in English; a quoted text keeps its language as its `lang` attribute and
// carries no mark on its face: the chrome is English only, and a language badge is chrome (ISS-1071).

const clock = { lang: "en" as const, now: Date.parse(AT), timeZone: "UTC" };
const report = (title: string, titleLang: "en" | "vi" | null) => ({
  area: "automation" as const,
  entity: "schedule" as const,
  key: `r-${title.length}`,
  title,
  titleLang,
  says: { title: verbatim(title) },
  touchedAt: AT,
  waitingOn: waitingOn("person", { who: say("standing.who.named", { name: "Ana" }), act: say("standing.act.fixSchedule"), rule: RULE }),
});

function shown() {
  const people = [report("Missing CLI verb: no verb links an issue to a requirement", "en"), report("Thiếu lệnh liên kết issue", "vi"), report("Written before the language was kept", null)]; // i18n-allow: Vietnamese text under test
  renderWithQuery(<StatusReport s={{ ...STATUS, waits: { ...STATUS.waits, people, peopleCount: people.length } }} slug="hop" clock={clock} window="7" onWindow={() => {}} />);
  return within(screen.getByTestId("status-waits"));
}

describe("the status page quoting what someone wrote", () => {
  it("keeps each text's language as its lang, and marks none", () => {
    const waits = shown();
    expect(waits.queryAllByTestId("written-mark")).toHaveLength(0);
    expect(waits.getByText("Missing CLI verb: no verb links an issue to a requirement")).toHaveAttribute("lang", "en");
    expect(waits.getByText("Thiếu lệnh liên kết issue")).toHaveAttribute("lang", "vi"); // i18n-allow: Vietnamese text under test
  });

  it("leaves a running issue's English title unmarked", () => {
    shown();
    expect(within(screen.getByTestId("status-in-flight")).queryByTestId("written-mark")).toBeNull();
  });
});
