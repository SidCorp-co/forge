// ISS-279 / FB-91: About offered Requirement, Issue, Release, Workflow and Screen, so feedback about
// Autoflow's MCP tool save_backend_workflow was filed as a Screen. About now offers "API route or
// tool", suggests what the project serves, and sends the name as `endpoint` for core to check.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { FeedbackForm } from "./feedback-form";

afterEach(() => vi.unstubAllGlobals());

/** The lists the About picker reads beside whatever a test serves: the viewer's projects, and the project's requirements, workflows and releases. */
const REQUIREMENTS = { requirements: [{ key: "REQ-3", title: "The board keeps its cards" }, { key: "REQ-12", title: "Labels" }], returned: 2 };
const lists = (c: { path: string }) =>
  c.path === "/projects"
    ? { body: [{ id: "p1", role: "member" }] }
    : c.path === "/projects/p1/requirements"
      ? { body: REQUIREMENTS }
      : c.path === "/projects/p1/workflows"
        ? { body: { workflows: [{ document: { flow: "sign-in", title: "Signing in" } }], returned: 1 } }
        : c.path === "/projects/p1/releases"
          ? { body: { releases: [{ version: "0.1.0" }] } }
          : undefined;
const core = (reply: (c: { method: string; path: string; body?: unknown }) => { status?: number; body: unknown } | undefined) =>
  fakeCore((c) => reply(c) ?? lists(c));


const SERVED = {
  endpoints: [
    { key: "shop-api:GET /pets", contract: "shop-api", version: "3.0.0", type: "openapi", element: "GET /pets" },
    {
      key: "shop-tools:save_backend_workflow",
      contract: "shop-tools",
      version: "1.0.0",
      type: "mcp-tools",
      element: "save_backend_workflow",
    },
  ],
};

describe("the feedback About picker", () => {
  it("offers a route or tool beside the other targets, and an issue only to a member of the Development space", async () => {
    core(() => undefined);
    renderWithQuery(<FeedbackForm projectId="p1" onDone={() => {}} />);
    const options = () => [...(screen.getByLabelText("Target type") as HTMLSelectElement).options].map((o) => o.textContent);
    await waitFor(() => expect(options()).toEqual(["Requirement", "Issue", "Release", "Workflow", "API route or tool", "Screen"]));
  });

  it("does not offer Issue to a reader who is not a member", async () => {
    core((c) => (c.path === "/projects" ? { body: [{ id: "p1", role: "viewer" }] } : undefined));
    renderWithQuery(<FeedbackForm projectId="p1" onDone={() => {}} />);
    await screen.findByTestId("feedback-choices");
    const options = [...(screen.getByLabelText("Target type") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["Requirement", "Release", "Workflow", "API route or tool", "Screen"]);
  });

  it("picks About by title from the project's own requirements, never a typed key, and refuses text naming none", async () => {
    const calls = core((c) => (c.method === "POST" ? { status: 201, body: { feedback: { key: "FB-3" } } } : undefined));
    renderWithQuery(<FeedbackForm projectId="p1" onDone={() => {}} />);
    const list = await screen.findByTestId("feedback-choices");
    expect([...list.querySelectorAll("option")].map((o) => [o.getAttribute("value"), o.getAttribute("label")])).toEqual([
      ["The board keeps its cards", "REQ-3"],
      ["Labels", "REQ-12"],
    ]);
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Cards vanish" } });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "The board kept cards" } });
    expect(screen.getByTestId("feedback-target-unmatched")).toHaveTextContent("No requirement of this project is titled or keyed “The board kept cards”: pick one from the list.");
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "The board keeps its cards" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ requirement: "REQ-3" }));
  });

  it("names an Issue About by picking it from the project's issues by key or title, never by a typed key", async () => {
    const calls = core((c) =>
      c.method === "POST"
        ? { status: 201, body: { feedback: { key: "FB-4" } } }
        : c.path.startsWith("/projects/p1/issues/search")
          ? { body: { items: [{ id: "i52", displayId: "ISS-52", title: "Snooze by the item's owner" }], total: 1 } }
          : undefined,
    );
    renderWithQuery(<FeedbackForm projectId="p1" onDone={() => {}} />);
    await waitFor(() =>
      expect([...(screen.getByLabelText("Target type") as HTMLSelectElement).options].map((o) => o.value)).toContain("issue"),
    );
    fireEvent.change(screen.getByLabelText("Target type"), { target: { value: "issue" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Snooze ends early" } });
    expect(screen.queryByPlaceholderText("ISS-12")).toBeNull();
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
    const picker = screen.getByRole("combobox", { name: "Target" });
    await userEvent.type(picker, "ISS-52");
    await userEvent.click(await screen.findByRole("option", { name: /ISS-52/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ issue: "ISS-52" }));
  });

  it("reads what the project serves only once a route or tool is picked, and suggests it", async () => {
    const calls = core((c) => (c.path === "/projects/p1/feedback/endpoints" ? { body: SERVED } : undefined));
    renderWithQuery(<FeedbackForm projectId="p1" onDone={() => {}} />);
    expect(calls.filter((c) => c.path.endsWith("/endpoints"))).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Target type"), { target: { value: "endpoint" } });
    const list = await screen.findByTestId("feedback-endpoints");
    expect([...list.querySelectorAll("option")].map((o) => [o.getAttribute("value"), o.textContent])).toEqual([
      ["shop-api:GET /pets", "Route GET /pets · shop-api 3.0.0"],
      ["shop-tools:save_backend_workflow", "Tool save_backend_workflow · shop-tools 1.0.0"],
    ]);
    expect(screen.getByLabelText("Target").getAttribute("list")).toBe(list.id);
  });

  // ISS-279's judge: on a project serving nothing the refusal came only after Send, in API terms
  it("says before Send that a project serving nothing has no route or tool to name, and to file it as a Screen", async () => {
    const calls = core((c) => (c.path.endsWith("/endpoints") ? { body: { endpoints: [] } } : undefined));
    renderWithQuery(<FeedbackForm projectId="p1" onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Target type"), { target: { value: "endpoint" } });
    const note = await screen.findByTestId("feedback-endpoints-none");
    expect(note).toHaveTextContent("This project publishes no API routes or tools, so there is none to name here. File it as a Screen instead.");
    expect(note.textContent).not.toMatch(/\/api|interface|endpoint/i);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("says nothing of the kind where the project serves routes or tools", async () => {
    core((c) => (c.path.endsWith("/endpoints") ? { body: SERVED } : undefined));
    renderWithQuery(<FeedbackForm projectId="p1" onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Target type"), { target: { value: "endpoint" } });
    await screen.findByTestId("feedback-endpoints");
    expect(screen.queryByTestId("feedback-endpoints-none")).toBeNull();
  });

  it("sends the name typed as the item's endpoint", async () => {
    const calls = core((c) => {
      if (c.path.endsWith("/endpoints")) return { body: SERVED };
      return c.method === "POST" ? { status: 201, body: { feedback: { key: "FB-2" } } } : undefined;
    });
    const onDone = vi.fn();
    renderWithQuery(<FeedbackForm projectId="p1" onDone={onDone} />);
    fireEvent.change(screen.getByLabelText("Target type"), { target: { value: "endpoint" } });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: " save_backend_workflow " } });
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Takes the graph only inline" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("FB-2"));
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/projects/p1/feedback",
      body: { kind: "bug", severity: "medium", title: "Takes the graph only inline", endpoint: "save_backend_workflow" },
    });
  });
});
