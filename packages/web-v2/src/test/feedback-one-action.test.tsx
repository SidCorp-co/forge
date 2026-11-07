// A project's Feedback list has one feedback action with one name (ISS-1072 round 3): its header drew
// "+ Feedback", the page's own, beside "Feedback", the bar's, two buttons of one name for one act. The
// page's action reads New feedback and the bar's yields to it there; every other page keeps the bar's.
// @direct-test-of packages/web-v2/src/design/primitives/top-bar-slot.tsx

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBarSlotProvider } from "@/design";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { FEEDBACK_SEED, P } from "@/test/vi-chrome-feedback";
import { Seeded } from "@/test/vi-chrome-requirements";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(cleanup);

const feedbackButtons = () => screen.getAllByRole("button").filter((b) => /feedback/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));

function shell(page: React.ReactNode) {
  return render(
    <Seeded data={[...FEEDBACK_SEED, [["version"], { version: "0.4.0" }]]}>
      <TopBarSlotProvider>
        <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
        {page}
      </TopBarSlotProvider>
    </Seeded>,
  );
}

describe("a project's Feedback list", () => {
  it("has one feedback action, New feedback, and no second Feedback button in the bar", async () => {
    shell(<FeedbackScreen projectId={P} slug="hop" />);
    await screen.findByRole("button", { name: /new feedback/i });
    expect(feedbackButtons().map((b) => b.textContent?.trim())).toEqual(["New feedback"]);
  });

  it("leaves the bar's Feedback on a page that files none of its own", () => {
    shell(<p>Issues</p>);
    expect(feedbackButtons()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /new feedback/i })).toBeNull();
  });
});
