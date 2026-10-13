// The run page (REQ-43 BC-5, BC-7): a person's view says each fact once — the header's badge alone
// says the state — and leaves the agent text out (session ids, stuck evidence, the attempt chain's run
// id, the lease's clocks, pipeline and job internals, raw event reasons); `?view=developer` draws it.

import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusReading } from "@/design/vocabulary";
import { access, data, RUNS } from "@/test/vi-chrome-agents";
import { Seeded } from "@/test/vi-chrome-requirements";
import type { RunStanding } from "../types";
import { RunItemScreen } from "./agents-item-screens";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/projects/hop/agents/runs/x",
  useParams: () => ({ slug: "hop" }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

afterEach(() => window.history.replaceState(null, "", "/"));

const STUCK = RUNS[1];
const HANDED = RUNS[9];

function page(r: RunStanding, qs = "") {
  window.history.replaceState(null, "", `/projects/hop/agents/runs/${r.id}${qs}`);
  render(
    <Seeded data={data()}>
      <RunItemScreen access={access} runId={r.id} />
    </Seeded>,
  );
  return within(screen.getByTestId("run-detail"));
}

const times = (text: string, word: string) => text.split(word).length - 1;

/** The page as a wide window draws it: the mobile title (md:hidden) stands in for the header below 768px only. */
function wideText(): string {
  const copy = screen.getByTestId("run-detail").cloneNode(true) as HTMLElement;
  copy.querySelector("[data-testid=detail-mobile-title]")?.remove();
  return copy.textContent ?? "";
}

describe("the run page, a person's view", () => {
  it("leaves the state to the header's badge: no banner, bar, rail row or moment says it again", () => {
    const body = page(STUCK);
    const label = statusReading("runStanding", STUCK.state, "en").label;
    expect(times(wideText(), label)).toBe(0);
    expect(screen.getByTestId("run-item-screen")).toBeTruthy();
    expect(body.queryByText("State")).toBeNull();
  });

  it("says the attempt once, in the Attempts tab, and the subject's key once", () => {
    const body = page(HANDED);
    const text = wideText();
    expect(body.queryByText("Attempt")).toBeNull();
    expect(times(text, "ISS-10")).toBe(1);
  });

  it("does not name a run holding its own lease a second time beside its subject", () => {
    page(STUCK);
    const text = wideText();
    expect(text).not.toContain("tho-1");
    expect(times(text, "ISS-2")).toBe(1);
  });

  it("draws no agent text: no session id, stuck evidence, lease tab, pipeline or job internals", () => {
    const body = page(STUCK);
    const text = wideText();
    expect(text).not.toContain("s-2");
    expect(text).not.toContain("last_heartbeat_at");
    expect(body.queryByRole("tab", { name: /Lease/ })).toBeNull();
    expect(body.queryByText("Pipeline")).toBeNull();
    expect(body.queryByText("Job type")).toBeNull();
    expect(screen.getByTestId("record-view-switch")).toBeTruthy();
  });
});

describe("the run page, the developer view", () => {
  it("draws the agent text a person's view leaves out", () => {
    const body = page(STUCK, "?view=developer");
    const text = wideText();
    expect(text).toContain("s-2");
    expect(text).toContain("last_heartbeat_at");
    expect(body.getByRole("tab", { name: /Lease/ })).toBeTruthy();
    expect(body.getByText("Pipeline")).toBeTruthy();
    expect(text).toContain("tho-1");
    expect(screen.getByTestId("record-view-switch")).toBeTruthy();
  });
});
