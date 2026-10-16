import { describe, expect, it } from "vitest";
import { type HostRead, hostMessageOf, parentOriginOf } from "./host-channel";

// The frame takes a host message only from the page that embeds it, at that page's origin, and reads
// each against the contract's own schemas: a wrong one is refused by name, another script's message
// is not the widget's at all.

const HOST = "https://shop.example.com";
const parent = {} as Window;
const event = (data: unknown, origin = HOST, source: unknown = parent) =>
  ({ data, origin, source }) as Pick<MessageEvent, "data" | "origin" | "source">;
const faultOf = (read: HostRead) => (read && "fault" in read ? read.fault : null);
const signed = { userId: "u1", ts: 1760000000, sig: "a".repeat(64) };

describe("a host message to the frame", () => {
  it("is taken from the embedding page: context, identify, open and close", () => {
    expect(hostMessageOf(event({ source: "forge-widget", type: "open" }), HOST, parent)).toEqual({
      message: { source: "forge-widget", type: "open" },
    });
    expect(hostMessageOf(event({ source: "forge-widget", type: "identify", signed }), HOST, parent)).toEqual({
      message: { source: "forge-widget", type: "identify", signed },
    });
    expect(
      hostMessageOf(event({ source: "forge-widget", type: "context", context: { url: `${HOST}/kettle`, productId: "k1" } }), HOST, parent),
    ).toEqual({ message: { source: "forge-widget", type: "context", context: { url: `${HOST}/kettle`, productId: "k1" } } });
  });

  it("is refused from another origin, from another window, and when the frame is not embedded", () => {
    expect(hostMessageOf(event({ source: "forge-widget", type: "open" }, "https://evil.example"), HOST, parent)).toEqual({
      fault: "a message from https://evil.example is not from the page embedding this frame",
    });
    expect(hostMessageOf(event({ source: "forge-widget", type: "open" }, HOST, {}), HOST, parent)).toEqual({
      fault: "a message did not come from the window embedding this frame",
    });
    expect(faultOf(hostMessageOf(event({ source: "forge-widget", type: "open" }), null, null))).toMatch(/is not from the page embedding/);
  });

  it("refuses a shape the contract does not take, naming the field", () => {
    expect(faultOf(hostMessageOf(event({ source: "forge-widget", type: "identify", signed: { ...signed, sig: "zz" } }), HOST, parent))).toMatch(
      /^identify refused at signed\.sig: /,
    );
    expect(faultOf(hostMessageOf(event({ source: "forge-widget", type: "context", context: { url: "x", spy: 1 } }), HOST, parent))).toMatch(
      /^context refused at /,
    );
    expect(hostMessageOf(event({ source: "forge-widget", type: "steal" }), HOST, parent)).toEqual({
      fault: '"steal" is not a message the frame takes',
    });
  });

  it("is not the widget's when it carries another source, and is left alone", () => {
    expect(hostMessageOf(event({ source: "react-devtools", type: "open" }, "https://evil.example"), HOST, parent)).toBeNull();
    expect(hostMessageOf(event("hello"), HOST, parent)).toBeNull();
  });
});

describe("the embedding page's origin", () => {
  const win = (over: { referrer?: string; ancestors?: string[]; top?: boolean }) => {
    const self = {} as Record<string, unknown>;
    self.parent = over.top ? self : {};
    self.location = over.ancestors ? { ancestorOrigins: { length: over.ancestors.length, item: (i: number) => over.ancestors?.[i] ?? null } } : {};
    self.document = { referrer: over.referrer ?? "" };
    return self as unknown as Window;
  };

  it("is the browser's ancestor origin where it keeps one, else the referrer's origin", () => {
    expect(parentOriginOf(win({ ancestors: [HOST], referrer: "https://other.example/" }))).toBe(HOST);
    expect(parentOriginOf(win({ referrer: `${HOST}/` }))).toBe(HOST);
  });

  it("is none for a frame opened on its own, or with no referrer to read", () => {
    expect(parentOriginOf(win({ top: true, referrer: `${HOST}/` }))).toBeNull();
    expect(parentOriginOf(win({}))).toBeNull();
  });
});
