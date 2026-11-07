// The project Agreements page (REQ-90 BC-1, BC-9; ISS-1111): each agreement in the lanes Forge default →
// Project change → Effective with its state, locked guarantees apart, search and a state filter, an
// inspector with the agreement's history and, for a project admin, change and restore, and a switch to
// what one run was given.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import {
  AGREEMENT_RUNS,
  AGREEMENTS_PROJECT as P,
  AGREEMENTS_RUN_SESSION,
  AGREEMENTS_VIEW,
  agreementDetail,
  RUN_CONTEXT,
} from "@/test/agreements.fixture";
import { AgreementsScreen } from "./agreements-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const PAGE = "/projects/hop/agreements";

function core(extra?: (c: { method: string; path: string; body: unknown }) => { status?: number; body: unknown } | undefined) {
  return fakeCore((c) => {
    const own = extra?.(c);
    if (own) return own;
    if (c.method !== "GET") return undefined;
    if (c.path === `/projects/${P}/agreements`) return { body: AGREEMENTS_VIEW };
    const one = /^\/projects\/[^/]+\/agreements\/([a-z0-9-]+)$/.exec(c.path);
    if (one?.[1]) return { body: agreementDetail(one[1]) };
    if (c.path.startsWith(`/projects/${P}/runs/standing`)) return { body: AGREEMENT_RUNS };
    if (c.path === `/projects/${P}/run-context?session=${AGREEMENTS_RUN_SESSION}`) return { body: RUN_CONTEXT };
    return undefined;
  });
}

const rowOf = (name: string) => {
  const row = screen.getAllByTestId("agreement-row").find((r) => r.getAttribute("data-name") === name);
  if (!row) throw new Error(`no row named ${name}`);
  return row;
};

beforeEach(() => window.history.replaceState(null, "", PAGE));
afterEach(() => vi.unstubAllGlobals());

describe("the Agreements page (REQ-90 BC-1)", () => {
  it("lays each agreement in the lanes Forge default, Project change and Effective, with its state", async () => {
    core();
    renderWithQuery(<AgreementsScreen projectId={P} slug="hop" canManage={false} />);
    const table = await screen.findByRole("table", { name: "Agreements" });
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Agreement", "Forge default", "Project change", "Effective", "State"]);

    // the override: the default it replaced, the change scoped to billing, and what agents get
    const verify = rowOf("Proportional verification");
    expect(within(verify).getByTestId("lane-forge").textContent).toContain("widening the checks only on evidence");
    expect(within(verify).getByTestId("lane-project").textContent).toContain("billing");
    expect(within(verify).getByTestId("lane-effective").textContent).toBe("A billing change runs the billing checks before it lands.");
    expect(within(verify).getByTestId("agreement-state").textContent).toBe("Overridden");

    expect(within(rowOf("Release window")).getByTestId("agreement-state").textContent).toBe("Project only");
    expect(within(rowOf("Release window")).getByTestId("lane-forge").textContent).toBe("");
    const audit = rowOf("Continuous audit");
    expect(within(audit).getByTestId("agreement-state").textContent).toBe("Conflict");
    expect(within(audit).getByTestId("lane-forge").textContent).toContain("Audit weekly");
    expect(within(audit).getByTestId("lane-effective").textContent).toBe("Audit every Friday, after the week's last release.");
  });

  it("puts the changes first, the inherited defaults and the locked guarantees in their own groups, each marked", async () => {
    core();
    renderWithQuery(<AgreementsScreen projectId={P} slug="hop" canManage={false} />);
    await screen.findByRole("table", { name: "Agreements" });
    const groups = screen.getAllByTestId("list-group").map((g) => g.textContent);
    expect(groups.map((g) => g?.replace(/\d+/, " #").trim())).toEqual(["Changed #", "Inherited #", "Locked #"]);
    // inherited and locked are one click away while there are changes; opening them shows each row
    fireEvent.click(screen.getByRole("button", { name: /Inherited/ }));
    fireEvent.click(screen.getByRole("button", { name: /Locked/ }));
    const batch = rowOf("Batch delivery");
    expect(within(batch).getByTestId("agreement-state").textContent).toBe("Inherited");
    expect(within(batch).getByTestId("lane-effective").textContent).toBe("Related work goes in batches of at least one whole issue.");
    expect(within(batch).getByTestId("lane-forge").querySelector("[data-same]")).not.toBeNull();
    const access = rowOf("Access");
    expect(within(access).getByLabelText("Locked")).toBeTruthy();
    expect(screen.getByText("Evidence-backed state")).toBeTruthy();
  });

  it("searches the names and rules, and filters by state", async () => {
    core();
    renderWithQuery(<AgreementsScreen projectId={P} slug="hop" canManage={false} />);
    await screen.findByRole("table", { name: "Agreements" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "billing" } });
    await waitFor(() => expect(screen.getAllByTestId("agreement-row").map((r) => r.getAttribute("data-name"))).toEqual(["Proportional verification"]));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });

    window.history.replaceState(null, "", `${PAGE}?state=conflict`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getAllByTestId("agreement-row").map((r) => r.getAttribute("data-name"))).toEqual(["Continuous audit"]));
  });

  it("shows no raw slug or revision code as text", async () => {
    core();
    renderWithQuery(<AgreementsScreen projectId={P} slug="hop" canManage />);
    const table = await screen.findByRole("table", { name: "Agreements" });
    expect(table.textContent).not.toMatch(/proportional-verification|project@|forge@/);
  });
});

describe("the inspector (REQ-90 BC-9)", () => {
  it("opens an agreement's default, its exact change, the effective rule, its reason, actor and history", async () => {
    core();
    renderWithQuery(<AgreementsScreen projectId={P} slug="hop" canManage={false} />);
    await screen.findByRole("table", { name: "Agreements" });
    fireEvent.click(within(rowOf("Proportional verification")).getByRole("button", { name: "Proportional verification" }));
    const drawer = await screen.findByRole("dialog", { name: "Proportional verification" });
    expect(within(drawer).getByTestId("inspect-forge").textContent).toContain(agreementDetail("proportional-verification").forge?.rule);
    expect(within(drawer).getByTestId("inspect-project").textContent).toContain("Billing broke twice in October");
    expect(within(drawer).getByTestId("inspect-project").textContent).toContain("Lan");
    expect(within(drawer).getByTestId("inspect-effective").textContent).toContain("billing");
    const history = await within(drawer).findAllByTestId("history-entry");
    expect(history.map((h) => h.getAttribute("data-revision"))).toEqual(["project@2", "project@1", "forge@1"]);
    expect(within(drawer).queryByRole("button", { name: "Change" })).toBeNull();
    expect(window.location.search).toContain("agreement=proportional-verification");
  });

  it("names both sides of a conflict", async () => {
    core();
    renderWithQuery(<AgreementsScreen projectId={P} slug="hop" canManage />);
    await screen.findByRole("table", { name: "Agreements" });
    fireEvent.click(within(rowOf("Continuous audit")).getByRole("button", { name: "Continuous audit" }));
    const drawer = await screen.findByRole("dialog", { name: "Continuous audit" });
    expect(within(drawer).getByTestId("inspect-conflict").textContent).toContain("Forge changed this default after the project's change.");
  });

  it("lets a project admin change an agreement and restore its default, sending the revision it read", async () => {
    const calls = core((c) => {
      if (c.method === "PUT") return { body: agreementDetail("proportional-verification") };
      if (c.method === "POST") return { body: AGREEMENTS_VIEW };
      return undefined;
    });
    renderWithQuery(<AgreementsScreen projectId={P} slug="hop" canManage />);
    await screen.findByRole("table", { name: "Agreements" });
    fireEvent.click(within(rowOf("Proportional verification")).getByRole("button", { name: "Proportional verification" }));
    const drawer = await screen.findByRole("dialog", { name: "Proportional verification" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Change" }));
    fireEvent.change(within(drawer).getByLabelText("Rule"), { target: { value: "A billing change runs the billing and tax checks." } });
    fireEvent.change(within(drawer).getByLabelText("Labels"), { target: { value: "billing, tax" } });
    fireEvent.change(within(drawer).getByLabelText("Reason"), { target: { value: "Tax rules moved" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`/projects/${P}/agreements/proportional-verification`);
    expect(put?.body).toEqual({ rule: "A billing change runs the billing and tax checks.", condition: { labels: ["billing", "tax"] }, reason: "Tax rules moved", projectRevision: 2 });

    fireEvent.click(within(drawer).getByRole("button", { name: "Restore default" }));
    fireEvent.change(within(drawer).getByLabelText("Reason"), { target: { value: "Back to the default" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/projects/${P}/agreements/proportional-verification/restore`);
    expect(post?.body).toEqual({ reason: "Back to the default", projectRevision: 2 });
  });

  it("offers no change on a locked guarantee, and sends a gate profile to the settings that hold it", async () => {
    core();
    renderWithQuery(<AgreementsScreen projectId={P} slug="hop" canManage />);
    await screen.findByRole("table", { name: "Agreements" });
    fireEvent.click(screen.getByRole("button", { name: /Locked/ }));
    fireEvent.click(within(rowOf("Access")).getByRole("button", { name: "Access" }));
    const locked = await screen.findByRole("dialog", { name: "Access" });
    expect(within(locked).queryByRole("button", { name: "Change" })).toBeNull();
    expect(within(locked).getByText("Locked")).toBeTruthy();
    fireEvent.keyDown(locked, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Inherited/ }));
    fireEvent.click(within(rowOf("Gate profile")).getByRole("button", { name: "Gate profile" }));
    const gates = await screen.findByRole("dialog", { name: "Gate profile" });
    expect(within(gates).queryByRole("button", { name: "Change" })).toBeNull();
    expect(within(gates).getByRole("link", { name: "Open settings" }).getAttribute("href")).toBe("/projects/hop/settings");
  });
});

describe("a run's recorded context (REQ-90 BC-9)", () => {
  it("switches from the current rules to what one run was given, telling a revision since changed from one still in force", async () => {
    core();
    window.history.replaceState(null, "", `${PAGE}?run=${AGREEMENTS_RUN_SESSION}`);
    renderWithQuery(<AgreementsScreen projectId={P} slug="hop" canManage />);
    const table = await screen.findByRole("table", { name: "Received" });
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Agreement", "Received", "Now"]);
    const verify = rowOf("Proportional verification");
    expect(within(verify).getByTestId("run-received").textContent).toBe("Project change");
    expect(within(verify).getByTestId("run-now").textContent).toBe("Changed");
    expect(within(rowOf("Batch delivery")).getByTestId("run-now").textContent).toBe("Same");
    // a rule's own reach is not an agreement's; the agreements it was not given wait in their own group
    expect(screen.getAllByTestId("agreement-row")).toHaveLength(4);
    expect(screen.getByRole("button", { name: /Not received/ })).toBeTruthy();

    fireEvent.click(within(verify).getByRole("button", { name: "Proportional verification" }));
    const drawer = await screen.findByRole("dialog", { name: "Proportional verification" });
    expect(await within(drawer).findByTestId("inspect-received")).toHaveProperty("textContent", expect.stringContaining("A billing change runs every check."));
  });
});
