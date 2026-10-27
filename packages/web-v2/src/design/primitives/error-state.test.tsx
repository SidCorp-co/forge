// @vitest-environment jsdom
//
// ISS-1229 r43, judge-120: an error state's title was a <p>, so a page made of one held no heading at all.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { ErrorState } from "./error-state";

afterEach(cleanup);

describe("an error state's title", () => {
  it("is a heading, one level under the page's own title by default", () => {
    render(<ErrorState mascot={false} title="Couldn't load issue" message="The server did not answer." error={undefined} onRetry={() => {}} />);
    expect(screen.getByRole("heading", { level: 2, name: "Couldn't load issue" })).toBeTruthy();
  });

  it("is the page's heading where the error state is the whole page", () => {
    render(<ErrorState mascot={false} level={1} title="This issue is not in Desk" message="It belongs to Vault." final />);
    expect(screen.getByRole("heading", { level: 1, name: "This issue is not in Desk" })).toBeTruthy();
  });

});

// ISS-1229 r44, judge-124: a page made of one error state names the tab from the primitive itself.
describe("an error state that is the whole page", () => {
  it("names the tab after its title while it is shown", () => {
    render(<ErrorState mascot={false} level={1} title="Page not found" message="This page moved." final />);
    expect(document.title).toBe("Page not found · Forge");
    cleanup();
    expect(document.title).toBe("Forge");
  });
});

// ISS-1229 r45, judge-129: four page-level load errors fell to the default "Couldn't load".
describe("an error state that is the whole page, given no title", () => {
  it("is refused by the type check", () => {
    // @ts-expect-error a page-level state names what failed in its title
    render(<ErrorState mascot={false} level={1} message="The server did not answer." final />);
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });
});

// ISS-1229 r46, judge-135: section and page errors that gave no title still read "Couldn't load" alone.
describe("an error state anywhere, given no title", () => {
  it("is refused by the type check, and no default stands in for it", () => {
    // @ts-expect-error every error state names what failed in its title
    render(<ErrorState mascot={false} message="The server did not answer." />);
    expect(screen.queryByRole("heading", { name: "Couldn't load" })).toBeNull();
  });
});

// ISS-1229 r48, judge-142: "Could not load agents" left its Retry off, and nothing made a caller say whether it had one.
describe("an error state's Retry", () => {
  it("is refused by the type check where a state says neither its Retry nor that it is final", () => {
    // @ts-expect-error a failed read writes its Retry, or the state is final
    render(<ErrorState mascot={false} title="Couldn't load the agents" message="The server did not answer." />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("is refused by the type check where a failed read's Retry may be undefined", () => {
    // @ts-expect-error a failed read's Retry is a function; an error no read changes is final instead
    render(<ErrorState mascot={false} title="Couldn't load the agents" message="Unavailable" onRetry={undefined} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("is refused by the type check where a final state is also given a Retry", () => {
    // @ts-expect-error a final answer takes no Retry
    render(<ErrorState mascot={false} title="Page not found" message="This page moved." final onRetry={() => {}} />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
  });

  it("is shown for a failed read, and reads it again when pressed", () => {
    const read = vi.fn();
    render(<ErrorState mascot={false} title="Couldn't load the agents" message="The server did not answer." error={new ApiError(503, "Unavailable")} onRetry={read} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("is not offered on a final state", () => {
    render(<ErrorState mascot={false} level={1} title="Page not found" message="This page moved." final />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

// ISS-1229 r50, judge-152 on criterion 478: most screens offered Retry on a 403, 404 or 422.
describe("an error state's Retry, by the one rule", () => {
  it.each([
    ["no answer", new TypeError("Failed to fetch")],
    ["408", new ApiError(408, "Request Timeout")],
    ["425", new ApiError(425, "Too Early")],
    ["429", new ApiError(429, "Too Many Requests")],
    ["500", new ApiError(500, "Internal Server Error")],
    ["503", new ApiError(503, "Service Unavailable")],
  ])("is offered for a read that failed with %s", (_, error) => {
    render(<ErrorState mascot={false} title="Couldn't load the agents" message="x" error={error} onRetry={() => {}} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it.each([400, 403, 404, 409, 410, 422])("is not offered for a read answered %s", (status) => {
    render(<ErrorState mascot={false} title="Couldn't load the agents" message="x" error={new ApiError(status, "No.")} onRetry={() => {}} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("is refused by the type check where a Retry is given without the read's error", () => {
    // @ts-expect-error the failed read's error decides whether Retry is offered
    render(<ErrorState mascot={false} title="Couldn't load the agents" message="x" onRetry={() => {}} />);
    expect(screen.getByRole("heading", { name: "Couldn't load the agents" })).toBeTruthy();
  });
});
