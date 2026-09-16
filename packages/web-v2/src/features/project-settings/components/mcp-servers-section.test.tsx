// @vitest-environment jsdom
//
// ISS-1038 — the Pipeline tab's MCP servers section is the screen that told the
// operator the wrong thing. It claimed connected integrations "layer on top",
// which reads as: connect one and it arrives. They do not — a sentinel in this
// same map is what makes the dispatcher inject them, this screen could not
// write one, and a stored one rendered here as a custom server whose spec
// printed as `true`.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineConfig } from "../types";
import { McpServersSection } from "./mcp-servers-section";

expect.extend(matchers);

const mutate = vi.fn();
vi.mock("../hooks", () => ({
  useUpdatePipelineConfig: () => ({
    mutate,
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  }),
}));

beforeEach(() => mutate.mockClear());
afterEach(cleanup);

function renderSection(mcpServers: Record<string, unknown>) {
  const config = { mcpServers, states: {} } as PipelineConfig;
  render(<McpServersSection projectId="p-1" config={config} canEdit />);
  return config;
}

describe("McpServersSection copy (ISS-1038)", () => {
  it("no longer claims connected integrations layer on top", () => {
    renderSection({});
    // The false claim was specifically about CONNECTED INTEGRATIONS arriving
    // on their own. "Per-stage overrides layer on top" is true and stays, so
    // this forbids the integration half by name rather than the phrase.
    expect(document.body.textContent).not.toMatch(/integrations[^.]*layer on top/i);
    expect(document.body.textContent).not.toMatch(/\(Postman, Epodsystem\)/i);
    // And says where they ARE switched, rather than saying nothing at all.
    expect(document.body.textContent).toMatch(/switched on Settings → Integrations/);
  });
});

describe("McpServersSection and a stored sentinel (ISS-1038)", () => {
  it("renders an integration sentinel as an integration, naming the Integrations tab", () => {
    renderSection({ epodsystem: true });
    expect(screen.getByText("Connected integrations")).toBeTruthy();
    expect(screen.getByText("epodsystem")).toBeTruthy();
    expect(screen.getByText("Epodsystem")).toBeTruthy();
    expect(document.body.textContent).toMatch(/Settings → Integrations → Agent MCP servers/);
  });

  it("does not render it as a custom server with a `true` spec", () => {
    renderSection({ epodsystem: true });
    // The old rendering: a custom row whose <pre> printed the raw value.
    expect(screen.queryByText("custom")).toBeNull();
    expect(document.body.querySelector("pre")).toBeNull();
  });

  it("recognises a labelled epodsystem_<label> sentinel too", () => {
    renderSection({ epodsystem_store_a: true });
    expect(screen.getByText("epodsystem_store_a")).toBeTruthy();
    expect(screen.getByText("Connected integrations")).toBeTruthy();
  });

  it("still renders a genuine custom server as one", () => {
    renderSection({ mything: { type: "stdio", command: "npx" } });
    expect(screen.getByText("custom")).toBeTruthy();
    expect(screen.queryByText("Connected integrations")).toBeNull();
  });

  it("carries the sentinel through a save untouched", () => {
    renderSection({ epodsystem: true, playwright: true });
    // Toggle a catalog entry so the form is dirty, then save.
    fireEvent.click(screen.getByLabelText("Chrome DevTools"));
    fireEvent.click(screen.getByText("Save MCP servers"));
    expect(mutate).toHaveBeenCalledTimes(1);
    const sent = mutate.mock.calls[0][0] as PipelineConfig;
    // `pixelight` and `butlocs` both carry a sentinel today; a save from this
    // screen dropping it would switch their whole autonomous lane off.
    expect(sent.mcpServers).toMatchObject({ epodsystem: true, playwright: true });
  });
});

describe("McpServersSection add-custom form (ISS-1038)", () => {
  function openForm() {
    fireEvent.click(screen.getByText("Add custom server"));
  }

  it("refuses an integration name BY NAME and points at the Integrations tab", () => {
    renderSection({});
    openForm();
    fireEvent.change(screen.getByPlaceholderText(/Server name/), {
      target: { value: "epodsystem" },
    });
    fireEvent.click(screen.getByText("Add server"));

    const message = document.body.textContent ?? "";
    expect(message).toMatch(/epodsystem/);
    expect(message).toMatch(/connected integration, not a custom server/);
    expect(message).toMatch(/Settings → Integrations/);
    // NOT the old refusal, which sent the operator away to write a spec that
    // would have injected nothing.
    expect(message).not.toMatch(/Spec must be valid JSON|Spec must be a JSON object/);
  });

  it("refuses every switchable provider by name, not just epodsystem", () => {
    for (const provider of ["postman", "sentry"]) {
      cleanup();
      mutate.mockClear();
      renderSection({});
      openForm();
      fireEvent.change(screen.getByPlaceholderText(/Server name/), {
        target: { value: provider },
      });
      fireEvent.click(screen.getByText("Add server"));
      expect(document.body.textContent).toMatch(
        new RegExp(`${provider}[\\s\\S]*connected integration`),
      );
    }
  });

  it("still refuses a non-object spec for a genuine custom name", () => {
    renderSection({});
    openForm();
    fireEvent.change(screen.getByPlaceholderText(/Server name/), { target: { value: "mything" } });
    fireEvent.change(screen.getByPlaceholderText(/Raw MCP spec JSON/), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByText("Add server"));
    expect(document.body.textContent).toMatch(/Spec must be a JSON object/);
  });
});
