// ISS-279 / FB-91: About offered Requirement, Issue, Release, Workflow and Screen, so feedback about
// Autoflow's MCP tool save_backend_workflow was filed as a Screen. About now offers "API route or
// tool", suggests what the project serves, and sends the name as `endpoint` for core to check.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { FeedbackForm } from "./feedback-form";

afterEach(() => vi.unstubAllGlobals());

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
  it("offers a route or tool beside the other targets", () => {
    renderWithQuery(<FeedbackForm projectId="p1" onDone={() => {}} />);
    const options = [...(screen.getByLabelText("Target type") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["Requirement", "Issue", "Release", "Workflow", "API route or tool", "Screen"]);
  });

  it("reads what the project serves only once a route or tool is picked, and suggests it", async () => {
    const calls = fakeCore((c) => (c.path === "/projects/p1/feedback/endpoints" ? { body: SERVED } : undefined));
    renderWithQuery(<FeedbackForm projectId="p1" onDone={() => {}} />);
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Target type"), { target: { value: "endpoint" } });
    const list = await screen.findByTestId("feedback-endpoints");
    expect([...list.querySelectorAll("option")].map((o) => [o.getAttribute("value"), o.textContent])).toEqual([
      ["shop-api:GET /pets", "Route GET /pets · shop-api 3.0.0"],
      ["shop-tools:save_backend_workflow", "Tool save_backend_workflow · shop-tools 1.0.0"],
    ]);
    expect(screen.getByLabelText("Target").getAttribute("list")).toBe(list.id);
  });

  it("sends the name typed as the item's endpoint", async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET") return { body: SERVED };
      return { status: 201, body: { feedback: { key: "FB-2" } } };
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
