// @vitest-environment jsdom
//
// ISS-1229 r54, criterion 495 (master's ruling on judge-168): four judges each found a Retry a source reading could not
// see — a query key bumped by a state setter, an effect run again, a reducer's dispatch, a GET wrapped in useMutation,
// a reload by assigning the address. What the rule protects is that a read the server refused with a wait is not
// asked again before that wait ends, and that is decided where the read is sent. Each way of asking again below is a
// judge's plant, pressed against a real refused read: no second request leaves before the wait, and once it is over
// the read goes out again.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useEffect, useReducer, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryButton } from "@/design/primitives/retry-button";
import { createQueryClient } from "@/providers/query-provider";
import { ApiError, apiClient, forgetHeldReads } from "./client";

expect.extend(matchers);

const RUNS = "/runs";
const refusedBody = { code: "RATE_LIMITED", message: "Too many requests in a short time. Try again in 20 seconds.", details: { retryAfterSeconds: 20 } };

let sent: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  forgetHeldReads();
  sent = [];
  let answered = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(`${init?.method ?? "GET"} ${String(input)}`);
    answered += 1;
    return answered === 1
      ? new Response(JSON.stringify(refusedBody), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "20" } })
      : new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const readRuns = () => apiClient<unknown[]>(RUNS);
const failed = (words = "Couldn't load the runs.") => <p>{words}</p>;

/** judge-168 z1 (and z5, behind `status !== "error"`): a key bumped by a state setter. */
function KeyBump() {
  const [tries, setTries] = useState(0);
  const q = useQuery({ queryKey: ["runs", tries], queryFn: readRuns, retry: false });
  if (q.status !== "error") return <p>{q.data?.length ?? 0} runs</p>;
  return <>{failed("Something went wrong with the runs.")}<button type="button" onClick={() => setTries((n) => n + 1)}>Ask again</button></>;
}

/** judge-168 z2: a hand-rolled read in an effect, run again by a state setter. */
function EffectBump() {
  const [runs, setRuns] = useState<unknown[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the plant's whole point is the effect run again by `asked`
  useEffect(() => {
    readRuns().then(setRuns, setError);
  }, [asked]);
  if (!error) return <p>{runs?.length ?? 0} runs</p>;
  return <>{failed()}<button type="button" onClick={() => setAsked((n) => n + 1)}>Load them</button></>;
}

/** judge-168 z6: the same read run again by a reducer's dispatch. */
function ReducerDispatch() {
  const [runs, setRuns] = useState<unknown[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [round, next] = useReducer((n: number) => n + 1, 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the plant's whole point is the effect run again by `round`
  useEffect(() => {
    readRuns().then(setRuns, setError);
  }, [round]);
  if (!error) return <p>{runs?.length ?? 0} runs</p>;
  return <>{failed()}<button type="button" onClick={next}>Load them</button></>;
}

/** judge-168 z3: a GET wrapped in useMutation. */
function MutationRead() {
  const q = useQuery({ queryKey: ["runs"], queryFn: readRuns, retry: false });
  const again = useMutation({ mutationFn: readRuns });
  if (!q.isError) return <p>{q.data?.length ?? 0} runs</p>;
  return <>{failed()}<button type="button" onClick={() => again.mutate()}>Load them</button></>;
}

/** judge-168 z7: the cached query found and fetched by hand. */
function CacheFindFetch() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["runs"], queryFn: readRuns, retry: false });
  if (!q.isError) return <p>{q.data?.length ?? 0} runs</p>;
  return <>{failed()}<button type="button" onClick={() => void qc.getQueryCache().find({ queryKey: ["runs"] })?.fetch().catch(() => {})}>Load them</button></>;
}

/** judge-158 p1, p2, p4; judge-162 x1, x3, x4; judge-165 y1, y6, y8, y14: a refetch, under any name or through props. */
function Refetch() {
  const { isError, refetch: load } = useQuery({ queryKey: ["runs"], queryFn: readRuns, retry: false });
  const actions = { again: () => void load() };
  return isError ? <>{failed()}<button type="button" aria-label="Retry" onClick={actions.again}>↻</button></> : null;
}

/** The menu-item plant of r51: the read invalidated. */
function Invalidate() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["runs"], queryFn: readRuns, retry: false });
  return q.isError ? <>{failed()}<button type="button" onClick={() => void qc.invalidateQueries({ queryKey: ["runs"] })}>Check now</button></> : null;
}

/** judge-165 y9: fetchQuery. */
function FetchQuery() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["runs"], queryFn: readRuns, retry: false });
  const again = () => void qc.fetchQuery({ queryKey: ["runs"], queryFn: readRuns }).catch(() => {});
  return q.isError ? <>{failed()}<button type="button" onClick={again}>Load them</button></> : null;
}

/** judge-165 y7, y4, y5: a hand-rolled read in the press itself, on a click, a form's submit or a pointer's lift. */
function HandRolled() {
  const q = useQuery({ queryKey: ["runs"], queryFn: readRuns, retry: false });
  const again = () => void readRuns().catch(() => {});
  if (!q.isError) return null;
  return (
    <form onSubmit={(e) => { e.preventDefault(); again(); }}>
      {failed()}
      <button type="submit" onPointerUp={again}>Load them</button>
    </form>
  );
}

/** judge-165 y12: the reading part remounted by a key. */
function RemountByKey() {
  const [attempt, setAttempt] = useState(0);
  return (
    <>
      <RemountedRuns key={attempt} />
      <button type="button" onClick={() => setAttempt((n) => n + 1)}>Load them</button>
    </>
  );
}
function RemountedRuns() {
  const q = useQuery({ queryKey: ["runs"], queryFn: readRuns, retry: false, staleTime: 0, gcTime: 0 });
  return q.isError ? failed() : <p>runs</p>;
}

function draw(part: () => ReactNode) {
  const Part = part;
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <Part />
    </QueryClientProvider>,
  );
}

/** Lets every promise the press set off settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const ways: [string, () => ReactNode][] = [
  ["a key bumped by a state setter (z1, z5)", KeyBump],
  ["an effect run again by a state setter (z2)", EffectBump],
  ["an effect run again by a reducer's dispatch (z6)", ReducerDispatch],
  ["a GET wrapped in useMutation (z3)", MutationRead],
  ["the cached query found and fetched (z7)", CacheFindFetch],
  ["a refetch under another name, behind an object's member (p1, p2, p4, x1, x3, x4, y1, y6, y8, y14)", Refetch],
  ["the read invalidated (r51's menu item)", Invalidate],
  ["fetchQuery (y9)", FetchQuery],
  ["a hand-rolled read on a press, a submit and a pointer's lift (y4, y5, y7)", HandRolled],
  ["the reading part remounted by a key (y12)", RemountByKey],
];

describe("a read the server refused with a wait (criterion 495)", () => {
  it.each(ways)("is not sent again before the wait ends, asked by %s", async (_, part) => {
    draw(part);
    const press = await screen.findByRole("button");
    expect(sent).toEqual(["GET /api/runs"]);

    fireEvent.pointerUp(press);
    fireEvent.click(press);
    await settle();
    vi.setSystemTime(Date.now() + 19_000);
    fireEvent.click(screen.getByRole("button"));
    await settle();
    expect(sent).toEqual(["GET /api/runs"]);

    vi.setSystemTime(Date.now() + 1_500);
    fireEvent.click(screen.getByRole("button"));
    await settle();
    expect(sent).toEqual(["GET /api/runs", "GET /api/runs"]);
  });

  it("answers at once with the same refusal and the time left, ending when the first one said", async () => {
    const refusal = (e: unknown) => e as ApiError;
    const first = await readRuns().then(() => null, refusal);
    vi.setSystemTime(Date.now() + 5_000);
    const again = await readRuns().then(() => null, refusal);
    expect(sent).toEqual(["GET /api/runs"]);
    expect(again).toBeInstanceOf(ApiError);
    expect(again).toMatchObject({ status: 429, code: "RATE_LIMITED", message: first?.message, retryAt: first?.retryAt, read: "GET /runs" });
    expect((again?.retryAt ?? 0) - Date.now()).toBe(15_000);
  });

  // r54 review F1: answers to the same read already in flight when the hold was set do not lift or shorten it.
  it("keeps the hold whatever another answer already in flight says", async () => {
    const answers: ((res: Response) => void)[] = [];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (answers.length === 3) return Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
      return new Promise<Response>((resolve) => answers.push(resolve));
    });
    const refusedAfter = (seconds: number) =>
      new Response(JSON.stringify(refusedBody), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(seconds) } });
    const reads = [readRuns().catch(() => {}), readRuns().catch(() => {}), readRuns().catch(() => {})];
    answers[0]?.(refusedAfter(20));
    await reads[0];
    answers[1]?.(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    await reads[1];
    answers[2]?.(refusedAfter(5));
    await reads[2];
    vi.setSystemTime(Date.now() + 10_000);
    await expect(readRuns()).rejects.toMatchObject({ status: 429 });
    expect(sent).toHaveLength(3);
  });

  it("is held across a reload of the page (z4, p3, y10)", async () => {
    await readRuns().catch(() => {});
    vi.resetModules();
    const reloaded = await import("./client");
    await expect(reloaded.apiClient(RUNS)).rejects.toMatchObject({ status: 429 });
    expect(sent).toEqual(["GET /api/runs"]);
  });

  it("holds only that read: another address, and a write to the same one, still go out", async () => {
    await readRuns().catch(() => {});
    await apiClient("/labels");
    await apiClient(RUNS, { method: "POST", body: "{}" });
    expect(sent).toEqual(["GET /api/runs", "GET /api/labels", "POST /api/runs"]);
  });

  it("is sent again by the one Retry, which waits the wait out first", async () => {
    function Runs() {
      const q = useQuery({ queryKey: ["runs"], queryFn: readRuns, retry: false });
      return q.isError ? <RetryButton error={q.error} onRetry={() => void q.refetch()} /> : <p>{q.data?.length ?? 0} runs</p>;
    }
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    draw(Runs);
    expect(await screen.findByRole("timer")).toHaveTextContent("You can retry in 20 seconds.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(21_000)));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("0 runs")).toBeInTheDocument();
    expect(sent).toEqual(["GET /api/runs", "GET /api/runs"]);
  });
});
