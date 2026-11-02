// ISS-761: a release run ends by its abort, which records who ended it and why. The Runs screen
// offered the generic Cancel on a release run, which core now refuses (RELEASE_RUN_CANCEL_USE_ABORT);
// it offers the release's abort instead, sent only with the reason the person gives.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RUNS } from "@/test/vi-chrome-agents";
import { renderWithQuery } from "@/test/render";
import type { RunStanding } from "../types";
import { RunActions } from "./run-views";

const apiClient = vi.hoisted(() => vi.fn((_path: string, _init?: RequestInit) => Promise.resolve({})));
vi.mock("@/lib/api/client", async (orig) => ({ ...(await orig<object>()), apiClient }));
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const [base] = RUNS;
if (!base) throw new Error("the agents chrome seeds no run");
const live = (over: Partial<RunStanding>): RunStanding => ({ ...base, outcome: null, ...over });
const release = live({ id: "run-rel", projectId: "proj-1", release: { version: "0.4.0", stage: null, verdict: null, attemptAt: null } });

describe("a live release run on the Runs screen", () => {
  it("offers the release's abort, never the generic cancel", () => {
    renderWithQuery(<RunActions r={release} slug="catalog" canWrite />);
    expect(screen.getByTestId("run-abort-release")).toHaveTextContent("Abort release");
    expect(screen.queryByTestId("run-cancel")).toBeNull();
  });

  it("aborts through the release's own door with the reason given, and not before one is", async () => {
    renderWithQuery(<RunActions r={release} slug="catalog" canWrite />);
    fireEvent.click(screen.getByTestId("run-abort-release"));
    expect(screen.getByTestId("run-abort-confirm")).toBeDisabled();
    fireEvent.change(screen.getByTestId("run-abort-reason"), { target: { value: "Target is down; re-cut tomorrow." } });
    fireEvent.click(screen.getByTestId("run-abort-confirm"));
    await waitFor(() => expect(apiClient).toHaveBeenCalled());
    const [path, init] = apiClient.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/projects/proj-1/release-batches/run-rel/abort");
    expect(init.method).toBe("POST");
    expect(typeof init.body === "string" ? JSON.parse(init.body) : null).toEqual({ reason: "Target is down; re-cut tomorrow." });
  });

  it("keeps the generic cancel on a run that is no release", () => {
    renderWithQuery(<RunActions r={live({ release: null })} slug="catalog" canWrite />);
    expect(screen.getByTestId("run-cancel")).toBeInTheDocument();
    expect(screen.queryByTestId("run-abort-release")).toBeNull();
  });
});
