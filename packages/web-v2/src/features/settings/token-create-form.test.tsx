import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { TokenCreateForm } from "./components/token-create-form";
import type { PatMenu } from "./types";

// REQ-27 BC-4 (the owner's ruling of 2026-10-08): the token screen says what Full means in one line,
// and a named grant can pick the approvals as well as the route groups, as `GET /api/pat` lists them.

vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-me", hasPassword: true } }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MENU: PatMenu = {
  permissions: ["issues:read", "projects:write"],
  explicit: ["suggestions.approve", "releases.approve"],
  full: "*",
};

function renderForm() {
  const calls = fakeCore((call) => {
    if (call.method === "GET" && call.path === "/projects") return { body: [] };
    if (call.method === "POST" && call.path === "/pat") return { status: 201, body: { ...(call.body as object), id: "t-1", plaintext: "x" } };
    return undefined;
  });
  renderWithQuery(<TokenCreateForm tokens={[]} menu={MENU} onCreated={() => {}} />);
  return calls;
}

describe("the token screen says what Full means (REQ-27 BC-4)", () => {
  it("names Full as everything the role can do, approvals included", () => {
    renderForm();
    expect(screen.getByRole("radio", { name: "Full access — everything your role can do, approvals included" })).toBeTruthy();
  });

  it("lets a named grant pick an approval beside a route group, and sends both", async () => {
    const calls = renderForm();
    fireEvent.change(screen.getByPlaceholderText("e.g. CI deploy token"), { target: { value: "approver" } });
    fireEvent.click(screen.getByRole("radio", { name: "Only the permissions I pick" }));
    expect(screen.getByText("Approvals and other acts — a named token holds only those picked here")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "projects:write" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "suggestions.approve" }));
    fireEvent.click(screen.getByRole("button", { name: /Create token/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/pat")).toBe(true));
    const sent = calls.find((c) => c.method === "POST" && c.path === "/pat")?.body as { permissions: string[] };
    expect(sent.permissions).toEqual(["projects:write", "suggestions.approve"]);
  });

  it("sends Full alone when Full is chosen", async () => {
    const calls = renderForm();
    fireEvent.change(screen.getByPlaceholderText("e.g. CI deploy token"), { target: { value: "full" } });
    fireEvent.click(screen.getByRole("radio", { name: "Full access — everything your role can do, approvals included" }));
    expect(screen.queryByRole("checkbox", { name: "suggestions.approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Create token/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/pat")).toBe(true));
    const sent = calls.find((c) => c.method === "POST" && c.path === "/pat")?.body as { permissions: string[] };
    expect(sent.permissions).toEqual(["*"]);
  });
});
