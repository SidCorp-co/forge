// @vitest-environment jsdom
//
// ISS-1071 — the project-default MCP server map, which is catalog servers and nothing else.
//
// Two sentences on this screen sent operators somewhere that injected nothing. The blurb said
// "connected integrations (Postman, Epodsystem) layer on top", which was never true of this map;
// and the add-custom form refused an integration name for its SHAPE — "Spec must be a JSON
// object" — which reads as an instruction to type `{}` and get a stored key that injects nothing
// and is indistinguishable here from a working custom server.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineConfig } from "../types";
import { McpServersSection } from "./mcp-servers-section";

expect.extend(matchers);
afterEach(cleanup);

const updateMutate = vi.fn();

vi.mock("../hooks", () => ({
  useUpdatePipelineConfig: () => ({
    mutate: updateMutate,
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  }),
}));

function renderSection(config: PipelineConfig = { states: {} }) {
  return render(<McpServersSection projectId="proj-1" config={config} canEdit />);
}

function addCustomServer(name: string, spec: string) {
  fireEvent.click(screen.getByRole("button", { name: /add custom server/i }));
  fireEvent.change(screen.getByPlaceholderText(/server name/i), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText(/Raw MCP spec JSON/i), { target: { value: spec } });
  fireEvent.click(screen.getByRole("button", { name: /^add server$/i }));
}

const GENUINE_SPEC = '{ "type": "stdio", "command": "npx", "args": ["@scope/mcp"] }';

beforeEach(() => updateMutate.mockReset());

describe("what this screen says it does", () => {
  // cm:guard the assertion is on the FALSE half alone. "Per-stage overrides … layer on top" is
  // true and stays; what went is the claim that connected integrations do, which they never did.
  it("no longer claims connected integrations layer on top of this map", () => {
    renderSection();
    const blurb = screen.getByText(/Servers seeded into every agent/i).textContent ?? "";
    expect(blurb).not.toMatch(/integrations[^.]*layer on top/i);
    expect(blurb).not.toMatch(/\(Postman, Epodsystem\)/i);
    expect(blurb).toMatch(/Connected integrations are not set here/i);
  });

  it("keeps the per-stage half, which is true, and says where the grant IS set", () => {
    renderSection();
    expect(screen.getByText(/Per-stage overrides/i)).toBeInTheDocument();
    expect(screen.getByText(/Integrations tab/i)).toBeInTheDocument();
  });

  it("still offers each catalog server as a toggle", () => {
    renderSection();
    expect(screen.getByRole("switch", { name: /playwright/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /chrome devtools/i })).toBeInTheDocument();
  });
});

describe("addCustom", () => {
  // cm:guard the refusal must name the provider and the place the grant lives. Refused for its
  // shape instead, the message told the operator the spec was the problem, and `{}` cleared it.
  it("refuses an integration provider name BY that name, not by JSON shape", () => {
    renderSection();
    addCustomServer("epodsystem", GENUINE_SPEC);
    const said = screen.getByText(/epodsystem/i).textContent ?? "";
    expect(said).toMatch(/Integrations tab/i);
    expect(said).not.toMatch(/JSON object/i);
    expect(screen.queryByText(/Spec must be/i)).not.toBeInTheDocument();
  });

  it("refuses a suffixed multi-binding name the same way", () => {
    renderSection();
    addCustomServer("epodsystem_second_shop", GENUINE_SPEC);
    expect(screen.getByText(/epodsystem_second_shop/i).textContent ?? "").toMatch(
      /Integrations tab/i,
    );
  });

  it("refuses the name before the spec is even parsed, so an empty spec gets the same answer", () => {
    renderSection();
    addCustomServer("sentry", "not json at all");
    const said = screen.getByText(/sentry/i).textContent ?? "";
    expect(said).toMatch(/Integrations tab/i);
    expect(said).not.toMatch(/valid JSON/i);
  });

  it("still accepts a genuine custom server whose name is neither a catalog nor a provider name", () => {
    renderSection();
    addCustomServer("acme-linter", GENUINE_SPEC);
    expect(screen.queryByText(/Integrations tab, on that/i)).not.toBeInTheDocument();
    expect(screen.getByText("acme-linter")).toBeInTheDocument();
    expect(screen.getByText(/^custom$/)).toBeInTheDocument();
  });

  it("still refuses a spec that is not a JSON object, for a name that IS allowed", () => {
    renderSection();
    addCustomServer("acme-linter", "[1, 2]");
    expect(screen.getByText(/Spec must be a JSON object/i)).toBeInTheDocument();
  });
});

describe("a leftover sentinel already stored in the map", () => {
  it("is labelled as an integration that injects nothing, never as a custom server", () => {
    renderSection({ states: {}, mcpServers: { epodsystem: true, "acme-linter": { type: "stdio" } } });
    expect(screen.getByText(/Epodsystem integration — injects nothing from here/i)).toBeInTheDocument();
    expect(screen.getByText("acme-linter")).toBeInTheDocument();
    expect(screen.getByText(/^custom$/)).toBeInTheDocument();
  });
});

// The name field carries a worked example, and an example the form itself rejects is worse than
// none: it reads as the shape that works. It said `sentry` until ISS-1071 — a provider name this
// very form refuses by name — so an operator following the placeholder verbatim got a refusal.
// This asserts the example is a name the form would ACCEPT, rather than asserting today's string,
// so replacing it with another provider or catalog name goes red instead of shipping.
describe("the name field's worked example", () => {
  it("is a name this form accepts, not one it refuses", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /add custom server/i }));

    const placeholder = screen
      .getByPlaceholderText(/server name/i)
      .getAttribute("placeholder") as string;
    const example = placeholder.match(/e\.g\.\s*([^)]+)\)/)?.[1]?.trim();
    expect(example, `no "e.g. <name>" in ${placeholder}`).toBeTruthy();

    // Feed the field's own example through the ALREADY-OPEN form and require it to be accepted.
    fireEvent.change(screen.getByPlaceholderText(/server name/i), {
      target: { value: example as string },
    });
    fireEvent.change(screen.getByPlaceholderText(/Raw MCP spec JSON/i), {
      target: { value: '{"type":"http","url":"https://example.com/mcp"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add server$/i }));
    expect(screen.queryByText(/not a custom server/i)).toBeNull();
    expect(screen.getByText(example as string)).toBeInTheDocument();
  });
});
