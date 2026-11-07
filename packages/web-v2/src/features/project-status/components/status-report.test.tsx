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

// Raw keys never lead a row (ISS-1072 round 2): each row of the report leads with its title, the title
// is the link, and the key is the link's tooltip, never text on the face.
describe("the status page's rows", () => {
  it("lead with the title, each key only in its link's tooltip", () => {
    const stuck = { asOf: AT, count: 1, items: [{ kind: "requirement" as const, key: "REQ-71", title: "Each project releases on the owner's accept", code: "overdue" as never, reason: "r", via: null, since: AT, note: null, href: "/projects/hop/requirements/REQ-71", says: { reason: verbatim("Master owed it") } }] };
    const needsYou = { asOf: AT, decisions: [{ group: "approve" as never, key: "REQ-9", title: "Export to a sheet", question: "Agree Export to a sheet?", recommended: null, stuck: false, dueAt: null, href: "/projects/hop/requirements/REQ-9" }], more: 0, total: 1 };
    renderWithQuery(<StatusReport s={{ ...STATUS, stuck, needsYou }} slug="hop" clock={clock} window="7" onWindow={() => {}} />);
    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(/\b(REQ|ISS)-\d+/);
    for (const [title, key] of [
      ["Each project releases on the owner's accept", "REQ-71"],
      ["Agree Export to a sheet?", "REQ-9"],
      ["Referral screens", "ISS-20"],
    ] as const) {
      const link = screen.getAllByRole("link", { hidden: true, name: new RegExp(`^${title.replace(/[?']/g, ".")}`) })[0];
      expect(link, title).toHaveAttribute("title", key);
    }
    expect(within(screen.getByTestId("status-requirements")).getByRole("link", { hidden: true, name: "Referrals" })).toHaveAttribute("title", "REQ-4");
  });
});
