// ISS-1073: the board Pipeline drew repeated Issues, and Pair repeated Runners. A link kept to either
// lands where the work is now: /pipeline on Issues › Waves, /pair with no code on Runners. A runner's
// login still opens /pair with its code, where the person approves the box.
//
// @direct-test-of packages/web-v2/src/routes/_workspace/projects/$slug/pipeline/index.tsx
// @direct-test-of packages/web-v2/src/routes/_workspace/pair/index.tsx

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { componentOf } from "@/test/route-tree";

const replace = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => ({ value: "" }));
vi.mock("@/lib/navigation/router", async () =>
  (await import("@/test/navigation")).navigationDouble({
    useRouter: () => ({ push: vi.fn(), replace }),
    useParams: () => ({ slug: "hop" }),
    useSearchParams: () => new URLSearchParams(search.value),
  }),
);

import { Route as PairRoute } from "@/routes/_workspace/pair/index";
import { Route as PipelineRoute } from "@/routes/_workspace/projects/$slug/pipeline/index";

afterEach(() => {
  cleanup();
  replace.mockClear();
  search.value = "";
});

describe("rail rows nobody acts on (ISS-1073)", () => {
  it("sends a kept /pipeline link to Issues › Waves", () => {
    const Pipeline = componentOf(PipelineRoute, "routes/_workspace/projects/$slug/pipeline/index.tsx");
    renderWithQuery(<Pipeline />);
    expect(replace).toHaveBeenCalledWith("/projects/hop/issues?group=waves");
  });

  it("sends /pair with no code to Runners, where a device is paired", () => {
    const Pair = componentOf(PairRoute, "routes/_workspace/pair/index.tsx");
    renderWithQuery(<Pair />);
    expect(replace).toHaveBeenCalledWith("/runners");
  });

  it("keeps /pair with a runner's code as the page that approves the box", async () => {
    search.value = "code=ABCD-1234";
    const Pair = componentOf(PairRoute, "routes/_workspace/pair/index.tsx");
    renderWithQuery(<Pair />);
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
