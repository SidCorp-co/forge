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
const { AGENT_ADDRESS_MESSAGE } = await import("./agent-address");

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

// ISS-1421 round 3 — the register page refuses an agent address in the sign-in page's words, not the
// API's own lower-case sentence.
describe("the register form's refusal of an agent address", () => {
  const apiWords =
    "an address on agents.forge.invalid belongs to an agent account Forge mints, and no person signs up or signs in with one. Use an address you receive mail at.";

  it("shows the sentence the sign-in page shows, and goes with the address", async () => {
    register.mockRejectedValueOnce(new ApiError(409, apiWords, "AGENT_ADDRESS_RESERVED"));
    render(<RegisterForm />);
    fill("Email", "someagent@agents.forge.invalid");
    fill("Password", "a-long-enough-password");
    fill("Confirm password", "a-long-enough-password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(screen.getByText(AGENT_ADDRESS_MESSAGE)).toBeInTheDocument());
    expect(screen.queryByText(apiWords)).not.toBeInTheDocument();
    expect(AGENT_ADDRESS_MESSAGE).toMatch(/^[A-Z]/);

    fill("Email", "a.person@example.test");
    expect(screen.queryByText(AGENT_ADDRESS_MESSAGE)).not.toBeInTheDocument();
  });
});

// ISS-1421 r4 — judge-32 hit register's limit and read a bare "rate limit exceeded". Register and
// sign-in now show one capitalised sentence for it, saying when the next attempt is accepted.
describe("the register form's refusal by its rate limit", () => {
  it("says when to try again, in the sentence sign-in shows", async () => {
    const { rateLimitedSentence } = await import("./rate-limit-words");
    register.mockRejectedValueOnce(
      new ApiError(429, "rate limit exceeded", "RATE_LIMITED", { retryAfterSeconds: 2520 }),
    );
    render(<RegisterForm />);
    fill("Email", "a.person@example.test");
    fill("Password", "a-long-enough-password");
    fill("Confirm password", "a-long-enough-password");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    const said = rateLimitedSentence({ retryAfterSeconds: 2520 });
    await waitFor(() => expect(screen.getByText(said)).toBeInTheDocument());
    expect(said).toBe("Too many attempts from this network. Try again in 42 minutes.");
    expect(screen.queryByText("rate limit exceeded")).not.toBeInTheDocument();
  });
});
