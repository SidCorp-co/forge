// @vitest-environment jsdom
//
// ISS-1154 — the pipeline page is the only door to the board now, so it carries the rule the Issues
// Board tab carried: a project viewer gets the board without its write controls.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectPipelinePage from "./page";

expect.extend(matchers);
afterEach(cleanup);

let role: string | undefined;

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "forge-dev" }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({
    data: [{ id: "p1", slug: "forge-dev", role }],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/pipeline/components/pipeline-board", () => ({
  PipelineBoard: ({ canWrite }: { canWrite?: boolean }) => <div data-testid="board" data-can-write={String(canWrite)} />,
}));

describe("the pipeline page", () => {
  it.each([
    ["viewer", "false"],
    ["member", "true"],
    ["admin", "true"],
  ])("a %s project member gets canWrite=%s", (r, expected) => {
    role = r;
    render(<ProjectPipelinePage />);
    expect(screen.getByTestId("board")).toHaveAttribute("data-can-write", expected);
  });
});
