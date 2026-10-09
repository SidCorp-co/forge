import { describe, expect, it } from "vitest";
import { toolOutputText } from "./tool-output";

const body = { offer: { v: 1 }, note: "a button" };

describe("toolOutputText", () => {
  it("reads the plain JSON body core's own assistant stores", () => {
    expect(JSON.parse(toolOutputText(JSON.stringify(body)))).toEqual(body);
  });
  it("reads an MCP content envelope as the text it carries", () => {
    const stored = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(body) }] });
    expect(JSON.parse(toolOutputText(stored))).toEqual(body);
  });
  it("keeps plain text and an object as text", () => {
    expect(toolOutputText("CHAT_ACT_NOT_FROM_STATUS")).toBe("CHAT_ACT_NOT_FROM_STATUS");
    expect(JSON.parse(toolOutputText(body))).toEqual(body);
  });
});
