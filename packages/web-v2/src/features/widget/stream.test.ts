import { afterEach, describe, expect, it, vi } from "vitest";
import { follow, readStream, SseParser, type StreamRead, streamEventOf } from "./stream";

// The stream is read by hand because EventSource cannot carry the session token: the parser cuts
// event-stream text into events wherever a chunk boundary falls, each event is read against the
// contract or refused by name, and a dropped stream is reconnected while a refused one is not.

const TOKEN = `fw_sess_${"t".repeat(43)}`;
const message = { id: "m1", role: "assistant", text: "Which page?", at: "2026-10-16T10:00:00.000Z" };
const draft = {
  draftId: "d1",
  title: "Checkout button does nothing",
  did: "Pressed Pay",
  saw: "Nothing happened",
  expected: "The payment page",
  whereSeen: "/checkout",
  kind: "bug",
  state: "pending",
};

afterEach(() => vi.unstubAllGlobals());

describe("the event-stream parser", () => {
  it("cuts events wherever the chunks split, CRLF, multi-line data, comments and named events alike", () => {
    const parser = new SseParser();
    const frames = [
      ...parser.push(": keepalive\r\n\r\ndata: {\"a\""),
      ...parser.push(":1}\r"),
      ...parser.push("\n\r\nevent: note\ndata: one\ndata: two\nid: 7\n"),
      ...parser.push("\n"),
    ];
    expect(frames).toEqual([
      { event: "message", data: '{"a":1}', id: null },
      { event: "note", data: "one\ntwo", id: "7" },
    ]);
  });

  it("reads a CRLF split across two chunks as one line end, not a blank line", () => {
    const parser = new SseParser();
    expect([...parser.push("data: a\r"), ...parser.push("\ndata: b\r\n\r\n")]).toEqual([{ event: "message", data: "a\nb", id: null }]);
  });

  it("holds an event back until its blank line arrives", () => {
    const parser = new SseParser();
    expect(parser.push("data: half")).toEqual([]);
    expect(parser.push("\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "message", data: "half", id: null }]);
  });
});

describe("a stream event read against the contract", () => {
  it("takes every event type the contract names", () => {
    const events = [
      { type: "message", message },
      { type: "typing", on: true },
      { type: "draft", draft },
      { type: "filed", draftId: "d1", feedbackKey: "FB-12", statusUrl: "/w/status/fw_stat_x" },
      { type: "limit", code: "WIDGET_LIMIT_REACHED", detail: "30 turns a conversation" },
    ];
    for (const event of events) expect(streamEventOf(JSON.stringify(event))).toEqual({ event });
  });

  it("refuses what is not one, naming why", () => {
    const faults = [
      ["not json", "an event's data is not JSON"],
      [JSON.stringify({ type: "presence" }), '"presence" is not a widget stream event type'],
      [JSON.stringify({ type: "message", message: { ...message, role: "operator" } }), 'a message\'s role "operator" is neither visitor nor assistant'],
      [JSON.stringify({ type: "draft", draft: { ...draft, kind: "rant" } }), 'a draft\'s kind "rant" is not one the contract names'],
      [JSON.stringify({ type: "draft", draft: { ...draft, did: 3 } }), "a draft's did, expected or whereSeen is neither text nor null"],
      [JSON.stringify({ type: "filed", draftId: "d1" }), "a filed event lacks draftId, feedbackKey or statusUrl"],
      [JSON.stringify({ type: "limit", code: "SLOW_DOWN", detail: "x" }), 'a limit event\'s code "SLOW_DOWN" is not a widget refusal code'],
      [JSON.stringify({ type: "typing", on: "yes" }), "a typing event's on is not a boolean"],
    ] as const;
    for (const [data, fault] of faults) expect(streamEventOf(data)).toEqual({ fault });
  });
});

/** A stream body the test writes to, one chunk at a time. */
function openBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    body,
    write: (text: string) => controller?.enqueue(encoder.encode(text)),
    end: () => controller?.close(),
  };
}

describe("reading the session's stream", () => {
  it("asks with the session token as a Bearer and hands on each event as it arrives", async () => {
    const stream = openBody();
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(stream.body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    vi.stubGlobal("fetch", fetchMock);
    const reads: StreamRead[] = [];
    const done = readStream(TOKEN, { signal: new AbortController().signal, onRead: (r) => reads.push(r) });
    stream.write(`data: ${JSON.stringify({ type: "typing", on: true })}\n\n`);
    stream.write(`data: ${JSON.stringify({ type: "message", message })}\n\ndata: nope\n\n`);
    stream.end();
    await done;
    expect(reads).toEqual([{ event: { type: "typing", on: true } }, { event: { type: "message", message } }, { fault: "an event's data is not JSON" }]);
    const [url, init] = fetchMock.mock.calls[0] ?? ["", {}];
    expect(url).toBe("/api/widget/session/stream");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init.credentials).toBe("omit");
  });

  it("reconnects a stream that ends, and stops at a refusal by code", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve(new Response("", { status: 200 }));
        return Promise.resolve(new Response(JSON.stringify({ code: "WIDGET_SESSION_INVALID", message: "expired" }), { status: 403 }));
      }),
    );
    const on = { onRead: vi.fn(), onOpen: vi.fn(), onRetry: vi.fn(), onRefused: vi.fn() };
    const following = follow(TOKEN, new AbortController().signal, on);
    await vi.advanceTimersByTimeAsync(1000);
    await following;
    vi.useRealTimers();
    expect(on.onOpen).toHaveBeenCalledTimes(1);
    expect(on.onRetry).toHaveBeenCalledTimes(1);
    expect(on.onRefused).toHaveBeenCalledWith(expect.objectContaining({ code: "WIDGET_SESSION_INVALID", status: 403 }));
    expect(calls).toBe(2);
  });
});
