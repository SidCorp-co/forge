// The issue page's Stuck banner (REQ-48 BC-5; ISS-680, FB-281): a stuck issue reads as a short
// state and whom it waits on for what, in either language. Core's own sentence and the rule — a
// release hold's code, its reason with an API path, the double stop where a reason that ends in a
// period meets the sentence's — are agent text the Developer view alone draws. An issue not stuck
// draws no banner. The steward's note under it is the standing feature's (`StewardNoteLines`).
//
// @direct-test-of packages/web-v2/src/features/issues/components/issue-standing-bits.tsx

import type { IssueStanding } from "@forge/contracts/issue-standing";
import type { Said } from "@forge/contracts/said";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { productCopy } from "@/lib/i18n/product-copy";
import { renderWithQuery } from "@/test/render";
import { IssueStuckBanner, stuckStateKey } from "./issue-standing-bits";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

// a hold as core's automatic release records it (`release-batch/hold.ts`): a code, a long reason
// naming a route and ending in a period, and what clears it
const HOLD = {
  code: "RELEASE_ABORT_BLOCKED",
  reason:
    "The automatic release aborted its cut and could not put the issues back: the abort is blocked until a " +
    "person clears it: the open question answered, then cut the release by hand (POST /api/projects/p1/releases/cut) " +
    "once every issue it carried is back at `awaiting_release`.",
  owes: "human",
  waitingFor: "the open question answered",
  heldAt: "2026-10-24T00:00:00.000Z",
} as const;

const who: Said = { key: "standing.who.named", vars: { name: "Lan" } };
const act: Said = { key: "issues.releaseHold.act.releaseAbortBlocked" };
const rule: Said = { key: "issues.rule.releaseHeld", vars: { code: HOLD.code, reason: HOLD.reason } };

const standing = (stuck: boolean, code = "blocked") =>
  ({
    attentionGroup: stuck ? "stuck" : "queued",
    releaseHold: HOLD,
    waitingOn: {
      kind: "person",
      who: "Lan",
      act: "clear the blocked abort",
      rule: `${HOLD.code}: ${HOLD.reason}`,
      ref: null,
      dueAt: null,
      says: { who, act, rule },
    },
    times: {
      actClass: "person_act",
      since: "2026-10-24T00:00:00.000Z",
      dueAt: null,
      stuck: stuck
        ? {
            code,
            since: "2026-10-24T00:00:00.000Z",
            reason: `It waits on Lan first: ${HOLD.code}: ${HOLD.reason}.`,
            via: null,
            says: { reason: { key: "standing.stuck.blocked", vars: { who, rule } } },
          }
        : null,
      carriedBy: null,
      basis: "b1",
    },
  }) as unknown as IssueStanding;

function draw(s: IssueStanding, language: "en" | "vi", developer = false) {
  renderWithQuery(
    <InterfaceLanguageScope language={language}>
      <IssueStuckBanner standing={s} developer={developer} />
    </InterfaceLanguageScope>,
  );
  return screen.getByTestId("issue-stuck-banner");
}

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

describe("the issue page's Stuck banner reads as state (ISS-680)", () => {
  for (const language of ["en", "vi"] as const) {
    const t = productCopy(language);
    const [state, head, actWords] = [t("issues.stuckState.releaseHeld"), t("issues.banner.stuck"), t("issues.releaseHold.act.releaseAbortBlocked")];
    it(`a real release hold shows a short state and whom it waits on, no code, path or double stop (${language})`, () => {
      const banner = draw(standing(true), language);
      const text = banner.textContent ?? "";
      expect(text).toContain(head);
      expect(text).toContain(state);
      expect(text).toContain(`Lan · ${actWords}`);
      // the vi page reads its own words, never core's English act
      if (language === "vi") expect(actWords).not.toBe("clear the blocked abort");
      expect(text).not.toContain("RELEASE_ABORT_BLOCKED");
      expect(text).not.toMatch(/\/api\//);
      expect(text).not.toContain("..");
      expect(text).not.toContain("awaiting_release");
      expect(text).not.toContain("⟦");
      expect(banner).not.toHaveAttribute("title");
      // each string within the copy budget: the head and state a label's few words, whom and what one row
      const effect = screen.getByTestId("wait-effect").textContent ?? "";
      expect(words(text.replace(effect, ""))).toBeLessThanOrEqual(6);
      expect(words(effect.replace("·", ""))).toBeLessThanOrEqual(12);
    });
  }

  it("draws core's sentence and the hold's code and reason in the Developer view", () => {
    const banner = draw(standing(true), "en", true);
    expect(screen.getByTestId("issue-stuck-detail")).toHaveTextContent("It waits on Lan first: RELEASE_ABORT_BLOCKED");
    expect(banner).toHaveAttribute("title", expect.stringContaining("/api/projects/p1/releases/cut"));
  });

  it("reads a stuck code this build does not know as one generic word, never the code", () => {
    const s = { ...standing(true, "some_new_code"), releaseHold: null } as unknown as IssueStanding;
    expect(stuckStateKey(s)).toBe("issues.stuckState.unknown");
    const text = draw(s, "en").textContent ?? "";
    expect(text).toContain("Waiting");
    expect(text).not.toContain("some_new_code");
  });

  it("draws nothing for an issue that is not stuck", () => {
    renderWithQuery(<IssueStuckBanner standing={standing(false)} />);
    expect(screen.queryByTestId("issue-stuck-banner")).toBeNull();
  });
});
