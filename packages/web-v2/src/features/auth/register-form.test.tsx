// @vitest-environment jsdom
//
// ISS-1383 — the register screen's top banner describes the submission that failed. Once the
// email in the field is no longer the one it describes, it goes.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

expect.extend(matchers);

const register = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ register }) }));

const { RegisterForm } = await import("./register-form");

const duplicate = () => new ApiError(409, "Email already registered", "CONFLICT");

afterEach(() => {
  cleanup();
  register.mockReset();
});

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function submitDuplicate() {
  register.mockRejectedValueOnce(duplicate());
  render(<RegisterForm />);
  fill("Email", "taken@example.test");
  fill("Password", "a-long-enough-password");
  fill("Confirm password", "a-long-enough-password");
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  await waitFor(() => expect(screen.getByText("Email already registered")).toBeInTheDocument());
}

describe("the register form's banner", () => {
  it("goes once the email is changed to another address", async () => {
    await submitDuplicate();
    fill("Email", "other@example.test");
    expect(screen.queryByText("Email already registered")).not.toBeInTheDocument();
  });

  it("stays while only the password is edited", async () => {
    await submitDuplicate();
    fill("Password", "another-long-password");
    expect(screen.getByText("Email already registered")).toBeInTheDocument();
  });

  it("does not come up for an address the field no longer holds when the refusal arrives late", async () => {
    let refuse: (err: Error) => void = () => {};
    register.mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)));
    render(<RegisterForm />);
    fill("Email", "taken@example.test");
    fill("Password", "a-long-enough-password");
    fill("Confirm password", "a-long-enough-password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    fill("Email", "other@example.test");
    refuse(duplicate());
    await waitFor(() => expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled());
    expect(screen.queryByText("Email already registered")).not.toBeInTheDocument();
  });

  it("keeps a failure that is not about the address when the email changes, or arrives late", async () => {
    let refuse: (err: Error) => void = () => {};
    register.mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)));
    render(<RegisterForm />);
    fill("Email", "taken@example.test");
    fill("Password", "a-long-enough-password");
    fill("Confirm password", "a-long-enough-password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    fill("Email", "other@example.test");
    refuse(new Error("Network unavailable"));
    await waitFor(() => expect(screen.getByText("Network unavailable")).toBeInTheDocument());
    fill("Email", "third@example.test");
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
  });
});
