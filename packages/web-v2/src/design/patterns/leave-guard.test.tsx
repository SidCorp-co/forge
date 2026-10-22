// @vitest-environment jsdom
//
// ISS-1262: a page holding unsaved edits is asked about before it is left, whichever way it is
// left — the browser's own prompt, a link, a navigation the app starts from code, the Back button —
// and Stay keeps the page, the address and the edits while Leave goes. A page with nothing unsaved
// is never asked.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LeaveGuardProvider,
  useGuardedRouter,
  useLeaveGuardAttempt,
  useUnsavedChanges,
} from "./leave-guard";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

expect.extend(matchers);
afterEach(cleanup);

let went: string[];

function Page() {
  const [dirty, setDirty] = useState(false);
  const attempt = useLeaveGuardAttempt();
  const guarded = useGuardedRouter();
  useUnsavedChanges(dirty);
  return (
    <div>
      <button type="button" onClick={() => setDirty((d) => !d)}>
        toggle edits
      </button>
      <a
        href="/elsewhere"
        onClick={(e) => {
          e.preventDefault();
          went.push("link /elsewhere");
          window.history.pushState({}, "", "/elsewhere");
        }}
      >
        another page
      </a>
      <a href="#section">same page</a>
      <button type="button" onClick={() => window.history.replaceState(window.history.state, "", "/settings?tab=b")}>
        replace the query
      </button>
      <button type="button" onClick={() => attempt(() => went.push("code"))}>
        go from code
      </button>
      <button type="button" onClick={() => guarded.push("/settings")}>
        push this page
      </button>
      <button type="button" onClick={() => guarded.push("/elsewhere")}>
        push another page
      </button>
    </div>
  );
}

function mount() {
  return render(
    <LeaveGuardProvider>
      <Page />
    </LeaveGuardProvider>,
  );
}

const edit = () => fireEvent.click(screen.getByRole("button", { name: "toggle edits" }));
const dialog = () => screen.queryByText("Leave without saving?");

beforeEach(() => {
  router.push.mockClear();
  went = [];
  window.history.replaceState({}, "", "/before");
  window.history.pushState({}, "", "/settings");
});

describe("the browser's own prompt", () => {
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("is asked for while edits are unsaved", () => {
    mount();
    edit();
    expect(unload()).toBe(true);
  });

  it("is not asked a second time by the navigation of someone who has said Leave", () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "go from code" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(unload()).toBe(false);
  });

  it("is asked for again by an edit made after the person said Leave", () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "go from code" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    edit();
    edit();
    expect(unload()).toBe(true);
  });

  it("is not asked for when nothing is unsaved", () => {
    mount();
    expect(unload()).toBe(false);
  });

  it("stops being asked for once the edits are put away", () => {
    mount();
    edit();
    edit();
    expect(unload()).toBe(false);
  });
});

describe("a link inside the app", () => {
  it("is followed at once when nothing is unsaved", () => {
    mount();
    fireEvent.click(screen.getByRole("link", { name: "another page" }));
    expect(went).toEqual(["link /elsewhere"]);
    expect(dialog()).toBeNull();
  });

  it("is held back and asked about while edits are unsaved, and Stay leaves it unfollowed", () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("link", { name: "another page" }));
    expect(dialog()).toBeInTheDocument();
    expect(went).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(dialog()).toBeNull();
    expect(went).toEqual([]);
  });

  it("is followed once the person says Leave", async () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("link", { name: "another page" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(went).toEqual(["link /elsewhere"]));
  });

  it("leaves no entry of the guard's own behind: two presses of Back reach the page before", async () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("link", { name: "another page" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(window.location.pathname).toBe("/elsewhere"));

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/before"));
  });

  // ISS-1339 r3: a drawer closed over an unsaved edit dropped `field` from the address, and the
  // guard's Back off its own entry landed on the page's, which still carried it.
  it("keeps an address the page replaced while dirty once the edits are put away", async () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "replace the query" }));
    expect(window.history.state?.__leaveGuard).toBeDefined();
    edit();
    // The guard's Back has landed on the page's own entry, and what follows it has run.
    await waitFor(() => expect(window.history.state?.__leaveGuard).toBeUndefined());
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(window.location.search).toBe("?tab=b");
    expect(window.location.pathname).toBe("/settings");
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/before"));
  });

  it("is not asked about when it only moves within the page", () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("link", { name: "same page" }));
    expect(dialog()).toBeNull();
  });
});

describe("a navigation the app starts from code", () => {
  it("runs at once when nothing is unsaved", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "go from code" }));
    expect(went).toEqual(["code"]);
  });

  it("waits for the answer while edits are unsaved", async () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "go from code" }));
    expect(went).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(went).toEqual(["code"]));
  });
});

describe("the Back button", () => {
  const popped = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

  it("is answered, and Stay keeps the page and its address", async () => {
    mount();
    edit();
    window.history.back();
    await waitFor(() => expect(dialog()).toBeInTheDocument());
    expect(window.location.pathname).toBe("/settings");

    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    await popped();
    expect(window.location.pathname).toBe("/settings");

    window.history.back();
    await waitFor(() => expect(dialog()).toBeInTheDocument());
  });

  it("is answered again, not taken, by a second Back while the first is still unanswered", async () => {
    mount();
    edit();
    window.history.back();
    await waitFor(() => expect(dialog()).toBeInTheDocument());
    window.history.back();
    await popped();
    expect(window.location.pathname).toBe("/settings");
    expect(dialog()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(window.location.pathname).toBe("/before"));
    expect(dialog()).toBeNull();
  });

  it("goes back once the person says Leave", async () => {
    mount();
    edit();
    window.history.back();
    await waitFor(() => expect(dialog()).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(window.location.pathname).toBe("/before"));
    expect(dialog()).toBeNull();
  });

  it("is not asked about when nothing is unsaved", async () => {
    mount();
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/before"));
    expect(dialog()).toBeNull();
  });

  it("takes its own history entry away once the edits are put away", async () => {
    mount();
    edit();
    edit();
    await popped();
    expect(window.location.pathname).toBe("/settings");
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/before"));
    expect(dialog()).toBeNull();
  });

  it("still answers the first Back after edits were put away and made again", async () => {
    mount();
    edit();
    edit();
    await popped();
    edit();
    window.history.back();
    await waitFor(() => expect(dialog()).toBeInTheDocument());
    expect(window.location.pathname).toBe("/settings");
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    await popped();
    expect(window.location.pathname).toBe("/settings");
  });
});

describe("the guarded router", () => {
  it("pushes the page already shown at once, since nothing is left and the guard's entry must stay", async () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "push this page" }));
    expect(router.push).toHaveBeenCalledWith("/settings");
    expect(dialog()).toBeNull();

    window.history.back();
    await waitFor(() => expect(dialog()).toBeInTheDocument());
    expect(window.location.pathname).toBe("/settings");
  });

  it("asks before pushing another page, and pushes it once the person says Leave", async () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "push another page" }));
    expect(router.push).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/elsewhere"));
  });
});
