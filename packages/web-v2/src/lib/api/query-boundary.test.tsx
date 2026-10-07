// The loading and failed shells of a query-backed view: the title stays, Retry is offered only where a retry can help,
// and once the data is in the boundary adds no wrapper around what it renders.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { QueryBoundary } from "./query-boundary";

const query = (over: Partial<Parameters<typeof QueryBoundary<string>>[0]["query"]>) => ({
  isLoading: false,
  isError: false,
  data: "ready" as string | undefined,
  error: null as unknown,
  refetch: vi.fn(),
  ...over,
});

describe("QueryBoundary", () => {
  it("draws the title and the loader while loading", () => {
    render(
      <QueryBoundary query={query({ isLoading: true, data: undefined })} loadingLabel="loading things…" title={<h1>Things</h1>}>
        {() => <p>never</p>}
      </QueryBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Things" })).toBeInTheDocument();
    expect(screen.getByText("loading things…")).toBeInTheDocument();
    expect(screen.queryByText("never")).toBeNull();
  });

  it("draws the title and the refusal, never children, on a failure", () => {
    render(
      <QueryBoundary query={query({ isError: true, data: undefined, error: new ApiError(500, "boom") })} loadingLabel="x" title={<h1>Things</h1>}>
        {() => <p>never</p>}
      </QueryBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Things" })).toBeInTheDocument();
    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByText("never")).toBeNull();
  });

  it("reads an answer with no data as a failure, not as an empty view", () => {
    render(
      <QueryBoundary query={query({ data: undefined })} loadingLabel="x">
        {() => <p>never</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
  });

  it("offers Retry on a 5xx and withholds it on a 4xx unless asked to always", () => {
    const fail = (status: number) => query({ isError: true, data: undefined, error: new ApiError(status, "no") });
    const { rerender } = render(
      <QueryBoundary query={fail(500)} loadingLabel="x">
        {() => null}
      </QueryBoundary>,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    rerender(
      <QueryBoundary query={fail(404)} loadingLabel="x">
        {() => null}
      </QueryBoundary>,
    );
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    rerender(
      <QueryBoundary query={fail(404)} loadingLabel="x" retry="always">
        {() => null}
      </QueryBoundary>,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("hands the data to children and adds no wrapper of its own", () => {
    const { container } = render(
      <QueryBoundary query={query({})} loadingLabel="x" title={<h1>Things</h1>}>
        {(d) => <p data-testid="body">{d}</p>}
      </QueryBoundary>,
    );
    expect(container.firstElementChild).toBe(screen.getByTestId("body"));
    expect(screen.getByTestId("body")).toHaveTextContent("ready");
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
