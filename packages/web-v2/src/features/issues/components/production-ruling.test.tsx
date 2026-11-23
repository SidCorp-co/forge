// ISS-1431 (REQ-80 BC-11) on the issue page: a project admin gives a production ruling, the act in
// their words and a production-tier environment the project declares, through the issue's decision
// door (a `decision` naming the environment in `production`), and withdraws it with a reason; a
// reader who does not admin the project, a closed issue and a project declaring no production-tier
// environment show no control at all.
// @direct-test-of packages/web-v2/src/features/issues/components/production-ruling.tsx
// @direct-test-of packages/web-v2/src/features/issues/detail-hooks.ts
// @direct-test-of packages/web-v2/src/features/issues/detail-api.ts

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ProductionRuling } from "./production-ruling";

afterEach(() => vi.unstubAllGlobals());

const ENVIRONMENTS = {
  stg: { tier: "staging", deployment: { mode: "external" } },
  live: { tier: "production", deploysFrom: "main", deployment: { mode: "external" } },
};

const RULING = {
  id: "r1",
  kind: "decision",
  fields: [
    { key: "decision", value: "Set supplier PGPrints" },
    { key: "production", value: "live" },
  ],
  actorType: "user",
  actorId: "u1",
  createdAt: "2026-11-23T00:00:00Z",
};
const PLAIN = { ...RULING, id: "d2", fields: [{ key: "decision", value: "Hold the export" }] };

/** Core for a reader whose role on p1 is `role`, the project declaring `environments`. */
function core(role: string, environments: object = ENVIRONMENTS, decisions: object[] = []) {
  return fakeCore((c) => {
    if (c.path.startsWith("/projects?") || c.path === "/projects") return { body: [{ id: "p1", role }] };
    if (c.path === "/projects/p1/config") return { body: { declared: true, revision: 3, document: { environments } } };
    if (c.method === "GET" && c.path === "/issues/i1/events?kind=decision") return { body: { items: decisions } };
    if (c.method === "POST") return { status: 201, body: { ...RULING, id: "r9" } };
    return undefined;
  });
}

const issue = (status = "in_progress") => ({ id: "i1", projectId: "p1", status });

describe("a production ruling on the issue page", () => {
  it("is given by a project admin through the issue's decision door, naming the act and the environment", async () => {
    const calls = core("admin");
    const user = userEvent.setup();
    renderWithQuery(<ProductionRuling issue={issue()} />);
    await user.click(await screen.findByRole("button", { name: "Give ruling" }));
    const form = screen.getByTestId("give-ruling");
    const send = within(form).getByRole("button", { name: "Give ruling" });
    expect(send).toBeDisabled();
    await user.type(within(form).getByRole("textbox", { name: "Act" }), " Set supplier PGPrints ");
    await user.click(send);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/issues/i1/events",
        body: {
          kind: "decision",
          contract: 1,
          fields: [
            { key: "decision", value: "Set supplier PGPrints" },
            { key: "production", value: "live" },
          ],
        },
      }),
    );
  });

  it("lists each standing ruling, not other decisions, and withdraws one with a reason", async () => {
    const calls = core("admin", ENVIRONMENTS, [RULING, PLAIN]);
    const user = userEvent.setup();
    renderWithQuery(<ProductionRuling issue={issue()} />);
    const [row, ...rest] = await screen.findAllByTestId("production-ruling-row");
    expect(rest).toEqual([]);
    expect(row).toHaveTextContent("live");
    expect(row).toHaveTextContent("Set supplier PGPrints");
    await user.click(within(row).getByRole("button", { name: "Withdraw" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Set by hand instead");
    await user.click(screen.getByRole("button", { name: "Withdraw decision" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/issues/i1/events/r1/withdraw",
        body: { reason: "Set by hand instead" },
      }),
    );
  });

  it("shows core's refusal where the ruling was given", async () => {
    fakeCore((c) => {
      if (c.path.startsWith("/projects?") || c.path === "/projects") return { body: [{ id: "p1", role: "admin" }] };
      if (c.path === "/projects/p1/config") return { body: { declared: true, revision: 3, document: { environments: ENVIRONMENTS } } };
      if (c.method === "GET") return { body: { items: [] } };
      return {
        status: 403,
        body: { error: { code: "PERMISSION_FORBIDDEN", message: "refused", refusals: [{ code: "PERMISSION_FORBIDDEN", path: "", detail: "needs project.write" }] } },
      };
    });
    const user = userEvent.setup();
    renderWithQuery(<ProductionRuling issue={issue()} />);
    await user.click(await screen.findByRole("button", { name: "Give ruling" }));
    await user.type(screen.getByRole("textbox", { name: "Act" }), "Set the key");
    await user.click(within(screen.getByTestId("give-ruling")).getByRole("button", { name: "Give ruling" }));
    expect(await screen.findByTestId("give-ruling-refusal")).toHaveTextContent("needs project.write");
  });

  it("is not shown to a reader who does not admin the project, nor reads the project's document", async () => {
    const calls = core("member");
    renderWithQuery(<ProductionRuling issue={issue()} />);
    await waitFor(() => expect(calls.some((c) => c.path.startsWith("/projects"))).toBe(true));
    expect(screen.queryByTestId("production-ruling")).toBeNull();
    expect(calls.filter((c) => c.path.includes("/config") || c.path.includes("/events"))).toEqual([]);
  });

  it("is not shown on a closed issue, or where the project declares no production-tier environment", async () => {
    core("admin");
    const { unmount } = renderWithQuery(<ProductionRuling issue={issue("closed")} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("production-ruling")).toBeNull();
    unmount();
    const calls = core("admin", { stg: ENVIRONMENTS.stg });
    renderWithQuery(<ProductionRuling issue={issue()} />);
    await waitFor(() => expect(calls.some((c) => c.path === "/projects/p1/config")).toBe(true));
    expect(screen.queryByTestId("production-ruling")).toBeNull();
    expect(calls.filter((c) => c.path.includes("/events"))).toEqual([]);
  });
});
