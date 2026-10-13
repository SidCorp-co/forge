// @vitest-environment jsdom
//
// ISS-1262: a page holding unsaved edits is asked about before it is left, whichever way it is
// left — the browser's own prompt, a link, a navigation the app starts from code, the Back button —
// and Stay keeps the page, the address and the edits while Leave goes. A page with nothing unsaved
// is never asked.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeaveGuardProvider, useLeaveGuardAttempt, useUnsavedChanges } from "./leave-guard";

expect.extend(matchers);
afterEach(cleanup);

let went: string[];

function Page() {
  const [dirty, setDirty] = useState(false);
  const attempt = useLeaveGuardAttempt();
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
        }}
      >
        another page
      </a>
      <a href="#section">same page</a>
      <button type="button" onClick={() => attempt(() => went.push("code"))}>
        go from code
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

  it("is followed once the person says Leave", () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("link", { name: "another page" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(went).toEqual(["link /elsewhere"]);
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

  it("waits for the answer while edits are unsaved", () => {
    mount();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "go from code" }));
    expect(went).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(went).toEqual(["code"]);
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
});
