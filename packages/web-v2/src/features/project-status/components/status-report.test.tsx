import { verbatim } from "@forge/contracts/said";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import { AT, STATUS } from "../status-fixture";
import { StatusReport } from "./status-report";

// hop /status in vi, 2026-10-08: 25 of its English lines were harness reports agents wrote in English,
// quoted with nothing saying so. A quoted text now carries its language where it is not the reader's.

const clock = { lang: "vi" as const, now: Date.parse(AT), timeZone: "UTC" };
const report = (title: string, titleLang: "en" | "vi" | null) => ({
  area: "automation" as const,
  entity: "report" as const,
  key: `r-${title.length}`,
  title,
  titleLang,
  says: { title: verbatim(title) },
  touchedAt: AT,
  waitingOn: waitingOn("writers", { who: say("automation.who.harnessTriage"), act: say("standing.act.triageReport"), rule: RULE }),
});

function shown() {
  const people = [report("Missing CLI verb: no verb links an issue to a requirement", "en"), report("Thiếu lệnh liên kết issue", "vi"), report("Written before the language was kept", null)]; // i18n-allow: Vietnamese text under test
  renderWithQuery(
    <InterfaceLanguageScope language="vi">
      <StatusReport s={{ ...STATUS, waits: { ...STATUS.waits, people, peopleCount: people.length } }} slug="hop" clock={clock} window="7" onWindow={() => {}} />
    </InterfaceLanguageScope>,
  );
  return within(screen.getByTestId("status-waits"));
}

describe("the status page quoting what someone wrote", () => {
  it("marks an agent's English as English on a vi page, and nothing else", () => {
    const waits = shown();
    expect(waits.getAllByTestId("written-mark")).toHaveLength(1);
    expect(waits.getByText("Missing CLI verb: no verb links an issue to a requirement")).toHaveAttribute("lang", "en");
    expect(waits.getByText("Thiếu lệnh liên kết issue")).toHaveAttribute("lang", "vi"); // i18n-allow: Vietnamese text under test
  });

  it("marks a running issue's English title too", () => {
    shown();
    expect(within(screen.getByTestId("status-in-flight")).getByTestId("written-mark")).toHaveTextContent("en");
  });
});
