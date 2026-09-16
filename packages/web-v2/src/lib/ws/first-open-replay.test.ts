import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { replayOnFirstOpen } from "./event-router";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));
const unsubs: Array<() => void> = [];

const client = () =>
  new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, gcTime: 300_000, retry: false } },
  });

function mount(qc: QueryClient, queryKey: unknown[], queryFn: () => Promise<unknown>) {
  const observer = new QueryObserver(qc, { queryKey, queryFn });
  unsubs.push(observer.subscribe(() => {}));
}

afterEach(() => {
  while (unsubs.length > 0) unsubs.pop()?.();
});

describe("replayOnFirstOpen", () => {
  it("refetches a query holding data that arrived before the socket opened", async () => {
    const qc = client();
    let calls = 0;
    mount(qc, ["issues", "list"], async () => {
      calls += 1;
      return `v${calls}`;
    });
    await tick();

    replayOnFirstOpen(qc, Date.now() + 1);
    await tick();

    expect(calls).toBe(2);
  });

  it("does not refetch a query whose only data arrived after the socket opened", async () => {
    const qc = client();
    const openedAt = Date.now() - 5_000;
    let calls = 0;
    mount(qc, ["issues", "list"], async () => {
      calls += 1;
      return `v${calls}`;
    });
    await tick();

    replayOnFirstOpen(qc, openedAt);
    await tick();

    expect(calls).toBe(1);
  });

  it("refetches a query holding pre-open data while a later request is in flight", async () => {
    const qc = client();
    let calls = 0;
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const observer = new QueryObserver(qc, {
      queryKey: ["issues", "list"],
      queryFn: () => {
        const gate = gates[calls];
        calls += 1;
        return gate?.promise ?? Promise.resolve("late");
      },
    });
    unsubs.push(observer.subscribe(() => {}));
    await tick(5);
    gates[0]?.resolve("v1");
    await tick();
    expect(calls).toBe(1);

    observer.refetch();
    await tick(5);
    expect(calls).toBe(2);

    replayOnFirstOpen(qc, Date.now() + 1);
    gates[1]?.resolve("v2");
    await tick();

    expect(calls).toBe(3);
  });

  it("refetches a questions query whose data arrived after the socket opened", async () => {
    const qc = client();
    const openedAt = Date.now() - 5_000;
    let calls = 0;
    mount(qc, ["questions", "i1"], async () => {
      calls += 1;
      return `q${calls}`;
    });
    await tick();

    replayOnFirstOpen(qc, openedAt);
    await tick();

    expect(calls).toBe(2);
  });

  it("refetches a questions query holding pre-open data exactly once", async () => {
    const qc = client();
    let calls = 0;
    mount(qc, ["questions", "i1"], async () => {
      calls += 1;
      return `q${calls}`;
    });
    await tick();

    replayOnFirstOpen(qc, Date.now() + 1);
    await tick();

    expect(calls).toBe(2);
  });

  it("judges two queries sharing one prefix separately", async () => {
    const qc = client();
    let old = 0;
    let fresh = 0;
    mount(qc, ["issues", "list"], async () => {
      old += 1;
      return `old${old}`;
    });
    await tick();
    const openedAt = Date.now() + 1;
    await tick(5);
    mount(qc, ["issues", "search"], async () => {
      fresh += 1;
      return `fresh${fresh}`;
    });
    await tick();

    replayOnFirstOpen(qc, openedAt);
    await tick();

    expect(old).toBe(2);
    expect(fresh).toBe(1);
  });

  it("leaves a query under no replay prefix alone", async () => {
    const qc = client();
    let calls = 0;
    mount(qc, ["tokens"], async () => {
      calls += 1;
      return `t${calls}`;
    });
    await tick();

    replayOnFirstOpen(qc, Date.now() + 1);
    await tick();

    expect(calls).toBe(1);
  });
});
