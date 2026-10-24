// A failed onboarding analysis on the dashboard and in the room (ISS-605, REQ-10 BC-11): the line
// says it failed, who acts (the role holding onboarding.request, You to its holder) and the act, the
// room badge reads Failed, both read in Vietnamese, and the runner's tag waits in the Developer view.

import type { OnboardingHint as Hint } from "@forge/contracts/onboarding";
import { type Said, say, sayEn } from "@forge/contracts/said";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { fakeCore, renderWithQuery } from "@/test/render";
import { OnboardingHint } from "./onboarding-hint";
import { ThreadSub } from "./thread-sub";

vi.mock("@/features/chat-dock/dock", () => ({ useChatDock: () => ({ show: vi.fn() }) }));

/** The hint core's hint.ts:failedHint sends for forge's shape: revise attempt 10, read by `who`. */
function failedHint(who: Said, mayReanalyze: boolean): Hint {
  const lead = say("onboarding.hint.failed");
  const text = say("onboarding.hint.failedWaits", { n: 10, who });
  const actionLabel = say("onboarding.hint.askReanalysis");
  return {
    tone: "err",
    lead: sayEn(lead),
    text: sayEn(text),
    action: "reanalyze",
    actionLabel: sayEn(actionLabel),
    mayReanalyze,
    says: { lead, text, actionLabel },
  };
}

const ROLE = say("standing.who.holderOf", { perm: "onboarding.request" });
const YOU = say("standing.who.you");
/** The state a reader who does not hold onboarding.request reads, the runner's tag on the job. */
const failedState = (who: Said = ROLE, mayReanalyze = false) => ({
  onboarding: { status: "failed", openBatch: null, job: { endedWith: "cc-startup-death (≤3 msgs, no tool use)" } },
  hint: failedHint(who, mayReanalyze),
  firstRequirements: null,
});

function renderIn(language: "en" | "vi") {
  return renderWithQuery(
    <InterfaceLanguageScope language={language}>
      <OnboardingHint projectId="p1" projectName="forge" />
    </InterfaceLanguageScope>,
  );
}

describe("a failed onboarding analysis", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("names the role who acts and the act, never the permission id, and offers no control the reader may not use", async () => {
    fakeCore(() => ({ body: failedState() }));
    renderIn("en");
    const line = await screen.findByTestId("onboarding-hint");
    expect(line).toHaveTextContent("Onboarding analysis failed.");
    expect(line).toHaveTextContent("Attempt 10 failed · Waits on: Member");
    expect(line).not.toHaveTextContent("onboarding.request");
    expect(line).not.toHaveTextContent("Onboarding done.");
    expect(screen.queryByTestId("onboarding-hint-action")).toBeNull();
    expect(screen.getByTestId("onboarding-hint-act")).toHaveTextContent("Ask for a re-analysis");
    expect(line).toHaveTextContent("Waits on: Member · Ask for a re-analysis");
  });

  it("reads You to the reader who holds it, with the act to take", async () => {
    fakeCore(() => ({ body: failedState(YOU, true) }));
    renderIn("en");
    const line = await screen.findByTestId("onboarding-hint");
    expect(line).toHaveTextContent("Attempt 10 failed · Waits on: You");
    expect(screen.getByTestId("onboarding-hint-action")).toHaveTextContent("Ask for a re-analysis");
    expect(screen.queryByTestId("onboarding-hint-act")).toBeNull();
  });

  it("reads the role in Vietnamese, with no key and no permission id", async () => {
    fakeCore(() => ({ body: failedState() }));
    renderIn("vi");
    const line = await screen.findByTestId("onboarding-hint");
    expect(line).toHaveTextContent("Lần thử 10 thất bại · Đang chờ: Thành viên · Yêu cầu phân tích lại"); // i18n-allow: asserts the vi copy of the failed line
    expect(line).not.toHaveTextContent("onboarding.request");
    expect(line.textContent).not.toContain("⟦");
  });

  it("keeps the runner's failure tag behind the Developer view", async () => {
    fakeCore(() => ({ body: failedState() }));
    renderIn("en");
    const line = await screen.findByTestId("onboarding-hint");
    expect(line).not.toHaveTextContent("cc-startup-death");
    expect(screen.queryByTestId("onboarding-hint-ended")).toBeNull();
  });

  it("draws the failure tag in the Developer view", async () => {
    window.history.replaceState(null, "", "/?view=developer");
    fakeCore(() => ({ body: failedState() }));
    renderIn("en");
    expect(await screen.findByTestId("onboarding-hint-ended")).toHaveTextContent("cc-startup-death (≤3 msgs, no tool use)");
  });

  it("badges the room Failed, not Done", () => {
    renderWithQuery(<ThreadSub kind="onboarding" status="failed" />);
    expect(screen.getByTestId("thread-sub")).toHaveTextContent("Failed");
    expect(screen.getByTestId("thread-sub")).not.toHaveTextContent("Done");
  });
});
