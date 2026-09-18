// @vitest-environment jsdom
//
// The confirm page an unlinked-speaker refusal links to. What it has to get right is
// the branch: a signed-out reader is sent to sign in, a signed-in reader whose address
// matches gets one button, and a reader whose address does not match is told what to
// change rather than shown a button that would be refused.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const searchParams = new URLSearchParams({
  projectId: "p-1",
  source: "rocketchat",
  externalId: "RDJAkAgNzqJNttd8b",
});
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

let authUser: { id: string; email: string } | null = null;
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: authUser, isLoading: false }),
}));

const apiClient = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: (...args: unknown[]) => apiClient(...args),
  ApiError: class extends Error {},
}));

const { default: LinkChatPage } = await import("./page");

const SPEAKER = {
  source: "rocketchat",
  namespace: "chat.example.co",
  externalId: "RDJAkAgNzqJNttd8b",
  username: "chuongld",
  emailOnChannel: "chuongld@sidcorp.co",
};

function proposal(candidates: unknown[]) {
  return { speaker: SPEAKER, candidates, youMayConfirm: false };
}

beforeEach(() => {
  apiClient.mockReset();
  authUser = null;
});
afterEach(cleanup);

describe("link-chat", () => {
  it("asks a signed-out reader to sign in, and reads nothing on their behalf", async () => {
    render(<LinkChatPage />);
    expect(await screen.findByText(/sign in to continue/i)).toBeInTheDocument();
    expect(apiClient).not.toHaveBeenCalled();
  });

  it("offers one button when the address matches", async () => {
    authUser = { id: "u-1", email: "chuongld@sidcorp.co" };
    apiClient.mockResolvedValueOnce(
      proposal([
        { userId: "u-1", email: "chuongld@sidcorp.co", matchedOn: "address", confirmable: true },
      ]),
    );
    render(<LinkChatPage />);
    expect(await screen.findByRole("button", { name: /this is me/i })).toBeInTheDocument();
  });

  // The whole point of the page: a mismatch is told as a mismatch, naming both addresses,
  // instead of a button that the API would refuse with SPEAKER_NOT_THE_TARGET.
  it("names both addresses and offers no button when they differ", async () => {
    authUser = { id: "u-1", email: "someone.else@gmail.com" };
    apiClient.mockResolvedValueOnce(proposal([]));
    render(<LinkChatPage />);
    await waitFor(() => expect(screen.getByText(/chuongld@sidcorp.co/)).toBeInTheDocument());
    expect(screen.getByText(/someone.else@gmail.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /this is me/i })).toBeNull();
  });

  it("confirms as the signed-in reader and says the answer will now count", async () => {
    authUser = { id: "u-1", email: "chuongld@sidcorp.co" };
    apiClient
      .mockResolvedValueOnce(
        proposal([
          { userId: "u-1", email: "chuongld@sidcorp.co", matchedOn: "address", confirmable: true },
        ]),
      )
      .mockResolvedValueOnce({});
    render(<LinkChatPage />);
    (await screen.findByRole("button", { name: /this is me/i })).click();
    expect(await screen.findByText(/recorded as you/i)).toBeInTheDocument();
    expect(apiClient).toHaveBeenLastCalledWith("/projects/p-1/speaker-links", {
      method: "POST",
      body: JSON.stringify({ source: "rocketchat", externalId: "RDJAkAgNzqJNttd8b" }),
    });
  });
});
