// A failed onboarding analysis on the dashboard and in the room (ISS-605, REQ-10 BC-11): the line
// says it failed, who acts and the act, the room badge reads Failed, and both read in Vietnamese.

import type { OnboardingHint as Hint } from "@forge/contracts/onboarding";
import { say, sayEn } from "@forge/contracts/said";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { fakeCore, renderWithQuery } from "@/test/render";
import { OnboardingHint } from "./onboarding-hint";
import { ThreadSub } from "./thread-sub";

vi.mock("@/features/chat-dock/dock", () => ({ useChatDock: () => ({ show: vi.fn() }) }));

/** The hint core's hint.ts:failedHint sends for forge's shape: revise attempt 10, cc-startup-death. */
function failedHint(): Hint {
  const lead = say("onboarding.hint.failed");
  const text = say("onboarding.hint.failedWaits", {
    n: 10,
    why: say("onboarding.hint.endedWith", { why: "cc-startup-death" }),
    who: say("standing.who.holderOf", { perm: "onboarding.request" }),
  });
  const actionLabel = say("onboarding.hint.askReanalysis");
  return {
    tone: "err",
    lead: sayEn(lead),
    text: sayEn(text),
    action: "reanalyze",
    actionLabel: sayEn(actionLabel),
    mayReanalyze: true,
    says: { lead, text, actionLabel },
  };
}

const failedState = { onboarding: { status: "failed", openBatch: null }, hint: failedHint(), firstRequirements: null };

describe("a failed onboarding analysis", () => {
  it("shows the failure, who acts and the act on the dashboard line", async () => {
    fakeCore(() => ({ body: failedState }));
    renderWithQuery(<OnboardingHint projectId="p1" projectName="forge" />);
    const line = await screen.findByTestId("onboarding-hint");
    expect(line).toHaveTextContent("Onboarding analysis failed.");
    expect(line).toHaveTextContent("Attempt 10 failed: cc-startup-death · Waits on: A holder of onboarding.request");
    expect(screen.getByTestId("onboarding-hint-action")).toHaveTextContent("Ask for a re-analysis");
    expect(line).not.toHaveTextContent("Onboarding done.");
  });

  it("reads the same line in Vietnamese, with no key left unrendered", async () => {
    fakeCore(() => ({ body: failedState }));
    renderWithQuery(
      <InterfaceLanguageScope language="vi">
        <OnboardingHint projectId="p1" projectName="forge" />
      </InterfaceLanguageScope>,
    );
    const line = await screen.findByTestId("onboarding-hint");
    expect(line).toHaveTextContent("Lần thử 10 thất bại: cc-startup-death · Đang chờ: Người có quyền onboarding.request"); // i18n-allow: asserts the vi copy of the failed line
    expect(line.textContent).not.toContain("⟦");
  });

  it("badges the room Failed, not Done", () => {
    renderWithQuery(<ThreadSub kind="onboarding" status="failed" />);
    expect(screen.getByTestId("thread-sub")).toHaveTextContent("Failed");
    expect(screen.getByTestId("thread-sub")).not.toHaveTextContent("Done");
  });
});
