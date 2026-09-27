// @vitest-environment jsdom
//
// ISS-1167 measured on forge-beta: the rail read Forge Dev, the MCP tab's
// Project selector read Sidcorp Mail, and the snippet offered for copying was
// scoped to sidcorp-mail — the first project the list returned. The lists below
// put the current project second on purpose, so a tab that falls back to the
// list's first entry names the wrong slug here.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem } from "@/features/projects/types";
import { CurrentProjectProvider } from "@/features/shell/current-project";

expect.extend(matchers);
// jsdom has no layout; the Select scrolls its active option into view on open.
Element.prototype.scrollIntoView = vi.fn();

const SIDCORP_MAIL = {
  id: "0b9f3c2e-4d1a-4e6b-9a7c-2f5d8e1b3c40",
  slug: "sidcorp-mail",
  name: "Sidcorp Mail",
} as ProjectListItem;
const FORGE_DEV = {
  id: "da368b0a-8e21-4763-9d90-8f7b9d0c7115",
  slug: "forge-dev",
  name: "Forge Dev",
} as ProjectListItem;

let projects: ProjectListItem[] = [];
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: projects, isLoading: false, isError: false }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { getMcpUrl } from "../mcp";
import { McpTab } from "./mcp-tab";

function renderTab(current: ProjectListItem | null) {
  return render(
    <CurrentProjectProvider project={current}>
      <McpTab />
    </CurrentProjectProvider>,
  );
}

const snippetText = () => document.querySelector("pre code")?.textContent ?? "";
const target = () => screen.getByTestId("mcp-snippet-target");

beforeEach(() => {
  projects = [SIDCORP_MAIL, FORGE_DEV];
});
afterEach(cleanup);

describe("McpTab — the project a snippet configures", () => {
  it("opens on the project the person is working in, not the list's first entry", () => {
    renderTab(FORGE_DEV);
    expect(screen.getByRole("combobox")).toHaveTextContent("Forge Dev · forge-dev");
    expect(snippetText()).toContain('--header "X-Forge-Project-Slug: forge-dev"');
    expect(snippetText()).not.toContain("sidcorp-mail");
  });

  it("names the configured project beside Copy, as the one being worked in", () => {
    renderTab(FORGE_DEV);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(target()).toHaveTextContent(
      "This snippet configures Forge Dev forge-dev, the project you are working in.",
    );
  });

  it("follows a deliberate pick, and says it is not the project being worked in", () => {
    renderTab(FORGE_DEV);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: /Sidcorp Mail/ }));
    expect(snippetText()).toContain('--header "X-Forge-Project-Slug: sidcorp-mail"');
    expect(target()).toHaveTextContent(
      "This snippet configures Sidcorp Mail sidcorp-mail — not Forge Dev, the project you are working in.",
    );
  });

  it("offers no snippet, Copy or test until a project is chosen when none is current", () => {
    renderTab(null);
    expect(document.querySelector("pre")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByText("Test connection")).toBeNull();
    expect(screen.getByText("Choose a project")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: /Forge Dev/ }));
    expect(snippetText()).toContain('--header "X-Forge-Project-Slug: forge-dev"');
    expect(target()).toHaveTextContent("This snippet configures Forge Dev forge-dev.");
  });

  it("does not trust a current project the list no longer holds", () => {
    renderTab({ ...FORGE_DEV, id: "5e0c1f2a-7b3d-4c8e-9f60-1a2b3c4d5e6f", slug: "gone" });
    expect(document.querySelector("pre")).toBeNull();
    expect(screen.getByText("Choose a project")).toBeInTheDocument();
  });
});

// ISS-1175 measured with Claude Code 2.1.283 under an isolated HOME: an `mcpServers` block in
// ~/.claude/settings.json is not read at all, and the same block in `.mcp.json` is skipped for
// having a url and no type. The line `claude mcp add` writes is the one that connects.
describe("McpTab — what each client is told to do with its snippet", () => {
  const how = () => screen.getByTestId("mcp-snippet-how");
  const pick = (label: string) => fireEvent.click(screen.getByRole("tab", { name: label }));

  it("gives Claude CLI one line to run in a terminal, not a file to edit", () => {
    renderTab(FORGE_DEV);
    expect(snippetText().trim()).toBe(
      `claude mcp add --transport http --scope user forge ${getMcpUrl()}` +
        ' --header "Authorization: Bearer <YOUR_TOKEN_HERE>"' +
        ' --header "X-Forge-Project-Slug: forge-dev"',
    );
    expect(snippetText()).not.toContain("mcpServers");
    expect(how()).toHaveTextContent("run this line once in a terminal");
    expect(how()).not.toHaveTextContent("settings.json");
  });

  it("points Cursor at the home-folder file that applies to every folder", () => {
    renderTab(FORGE_DEV);
    pick("Cursor");
    expect(how()).toHaveTextContent("Add to ~/.cursor/mcp.json");
    expect(snippetText()).toContain('"X-Forge-Project-Slug": "forge-dev"');
  });

  it("shows a token example in the shape real tokens have", () => {
    renderTab(FORGE_DEV);
    const box = screen.getByLabelText("Personal access token");
    expect(box).toHaveAttribute("placeholder", "forge_pat_…");
  });
});
