// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContextBody } from "./components/context-panel";
import { type RoomToolCall, RAN_AS_LINE, ranAsOf, roomContext } from "./context";

expect.extend(matchers);
afterEach(cleanup);

const ME = "u-me";
const call = (over: Partial<RoomToolCall>): RoomToolCall => ({
  turnId: "t1",
  at: "2026-10-01T08:00:00Z",
  name: "forge_issues",
  arguments: '{"action":"get","id":"ISS-4"}',
  round: 1,
  isError: false,
  durationMs: 10,
  resultPreview: "ISS-4 is open",
  resultIssueRefs: ["ISS-4"],
  ranAsRecorded: true,
  ranAs: ME,
  refusalCode: null,
  ...over,
});

describe("ran with your permissions", () => {
  it("is said of a call whose recorded ranAs is the reader", () => {
    expect(ranAsOf(call({}), ME)).toBe("you");
  });

  it.each([
    ["no ranAs", call({ ranAs: null }), "nobody"],
    ["a ranAs never recorded", call({ ranAsRecorded: false, ranAs: null }), "unrecorded"],
    ["someone else's ranAs", call({ ranAs: "u-other" }), "another-member"],
  ])("is never said of a call with %s", (_, c, expected) => {
    expect(ranAsOf(c, ME)).toBe(expected);
    render(<ContextBody context={roomContext([c])} me={ME} slug="forge-dev" />);
    expect(screen.queryByText(RAN_AS_LINE.you)).toBeNull();
    cleanup();
  });

  it("is never said to a reader who is not known", () => {
    expect(ranAsOf(call({}), null)).toBe("another-member");
  });

  it("is shown on the call that earned it", () => {
    render(<ContextBody context={roomContext([call({})])} me={ME} slug="forge-dev" />);
    expect(screen.getByText(RAN_AS_LINE.you)).toBeInTheDocument();
  });
});

describe("the room's context", () => {
  it("sorts calls into sources, channel documents, holds and linked issues", () => {
    const ctx = roomContext([
      call({}),
      call({ name: "forge_memory_search", resultIssueRefs: ["ISS-9", "ISS-4"] }),
      call({ name: "forge_channel", arguments: '{"action":"read","ref":"FP-CN-12"}', resultIssueRefs: [] }),
      call({
        name: "forge_channel",
        arguments: '{"action":"submit","ref":"FP-ACK-7"}',
        isError: true,
        refusalCode: "CHANNEL_NOT_A_PARTY",
        resultIssueRefs: [],
      }),
      call({ name: "forge_channel", arguments: '{"action":"hold","thread":"FP-T-3","reason":"wait"}', resultIssueRefs: [] }),
    ]);
    expect(ctx.sources).toEqual([
      { name: "forge_issues", count: 1 },
      { name: "forge_memory_search", count: 1 },
      { name: "forge_channel", count: 1 },
    ]);
    expect(ctx.channel.map((t) => [t.kind, t.action, t.subject, t.refused, t.refusalCode])).toEqual([
      ["document", "submit", "FP-ACK-7", true, "CHANNEL_NOT_A_PARTY"],
      ["hold", "hold", "FP-T-3", false, null],
    ]);
    expect(ctx.issues).toEqual(["ISS-4", "ISS-9"]);
  });

  it("does not count a refused read as a source", () => {
    expect(roomContext([call({ isError: true })]).sources).toEqual([]);
  });
});
