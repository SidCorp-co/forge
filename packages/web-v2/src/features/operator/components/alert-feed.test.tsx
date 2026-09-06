// @vitest-environment jsdom
//
// ISS-653 — the alert feed's three claims that a screenshot cannot check: the
// crit-first order an operator reads top-down, the reap that only A2 carries,
// and the toast on both outcomes of that mutation.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertFeed, sortAlerts } from "./alert-feed";
import type { AdminAlert, AdminAlertId, AdminAlertStatus } from "../types";

expect.extend(matchers);

const toastMock = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: toastMock }) }));

const reapMock = vi.fn(async (_jobId: string) => ({ status: "cancelled" }));
vi.mock("../api", () => ({
  operatorApi: { reapJob: (jobId: string) => reapMock(jobId) },
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  reapMock.mockResolvedValue({ status: "cancelled" });
});

function alert(
  id: AdminAlertId,
  status: AdminAlertStatus,
  entities: AdminAlert["entities"] = [],
): AdminAlert {
  return {
    id,
    key: id.toLowerCase(),
    status,
    count: entities.length,
    detail: `${id} detail`,
    since: status === "ok" ? null : "2026-09-06T05:10:17.800Z",
    entities,
  };
}

const JOB_ID = "f2677ce3-b0f3-4d03-8732-2bb799b0ab4e";
const stuckJob = { ref: JOB_ID, kind: "job" as const, label: "drive · 10m" };

function renderFeed(alerts: AdminAlert[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AlertFeed alerts={alerts} />
    </QueryClientProvider>,
  );
}

describe("sortAlerts", () => {
  it("puts crit above warn above ok, whatever order the endpoint sent", () => {
    const sorted = sortAlerts([
      alert("A1", "ok"),
      alert("A2", "warn"),
      alert("A5", "crit"),
      alert("A3", "ok"),
      alert("A4", "warn"),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["A5", "A2", "A4", "A1", "A3"]);
  });

  it("is stable by id within one status, so the feed does not reshuffle on refetch", () => {
    const ids = sortAlerts([alert("A4", "ok"), alert("A1", "ok"), alert("A3", "ok")]).map(
      (a) => a.id,
    );
    expect(ids).toEqual(["A1", "A3", "A4"]);
  });
});

describe("the reap control", () => {
  it("is offered on an A2 job entity", () => {
    renderFeed([alert("A2", "warn", [stuckJob])]);
    expect(screen.getByRole("button", { name: /reap/i })).toBeInTheDocument();
  });

  // cm:guard A1 lists jobs too and its entity shape is identical, so an id-blind "kind === 'job' gets a button" puts a reap on the orphan alert, where cancelling the job does not repair the invariant that raised it
  it("is NOT offered on an A1 job entity", () => {
    renderFeed([alert("A1", "crit", [stuckJob])]);
    expect(screen.queryByRole("button", { name: /reap/i })).not.toBeInTheDocument();
  });

  it("cancels the entity's own job id, and only after the confirm", async () => {
    renderFeed([alert("A2", "warn", [stuckJob])]);

    fireEvent.click(screen.getByRole("button", { name: /^reap$/i }));
    expect(reapMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /reap job/i }));
    await waitFor(() => expect(reapMock).toHaveBeenCalledWith(JOB_ID));
  });

  it("raises a success toast when the cancel returns", async () => {
    renderFeed([alert("A2", "warn", [stuckJob])]);
    fireEvent.click(screen.getByRole("button", { name: /^reap$/i }));
    fireEvent.click(screen.getByRole("button", { name: /reap job/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" })),
    );
  });

  it("raises an error toast carrying the failure's message", async () => {
    reapMock.mockRejectedValueOnce(new Error("job is not cancellable"));
    renderFeed([alert("A2", "warn", [stuckJob])]);
    fireEvent.click(screen.getByRole("button", { name: /^reap$/i }));
    fireEvent.click(screen.getByRole("button", { name: /reap job/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "error", description: "job is not cancellable" }),
      ),
    );
  });
});
