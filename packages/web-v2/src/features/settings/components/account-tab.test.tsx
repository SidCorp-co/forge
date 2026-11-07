import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { AccountTab } from "./account-tab";

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { id: "9f3c2a10-7d1e-4c55-b0a2-1e2f3a4b5c6d", email: "me@example.invalid" } }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the account profile (ui-copy-rule: no raw ids as visible text)", () => {
  it("shows no user id, and copies it on the one action", async () => {
    fakeCore(() => undefined);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderWithQuery(<AccountTab />);
    expect(screen.queryByText("9f3c2a10-7d1e-4c55-b0a2-1e2f3a4b5c6d")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("9f3c2a10-7d1e-4c55-b0a2-1e2f3a4b5c6d"));
  });
});
