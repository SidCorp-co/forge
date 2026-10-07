import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { turnDoing } from "./turn-doing";

const t = productCopy("vi");
const running = (name: string, input: Record<string, unknown>) =>
  ({ type: "tool", tool: { id: "c", name, input } }) as const;

describe("the stage line says what a live turn is doing", () => {
  it("says it is reading the project before the first call, and what each call is", () => {
    expect(turnDoing([], t)).toBe("Đang đọc dữ liệu dự án"); // i18n-allow: a production ask or reply replayed as the test case
    expect(turnDoing([running("forge", { argv: ["issue", "--search", "export"] })], t)).toBe(
      "Đang đọc tracker: forge issue --search export", // i18n-allow: a production ask or reply replayed as the test case
    );
    expect(turnDoing([running("forge", { argv: ["new", "-", "--title", "x"] })], t)).toContain("Đang ghi vào tracker"); // i18n-allow: a production ask or reply replayed as the test case
    expect(turnDoing([running("forge_memory", { action: "search" })], t)).toBe("Đang tìm trong bộ nhớ dự án"); // i18n-allow: a production ask or reply replayed as the test case
    expect(turnDoing([running("offer_act", {})], t)).toBe("Đang chuẩn bị nút thao tác cho bạn"); // i18n-allow: a production ask or reply replayed as the test case
  });

  it("says nothing more once the call returned or the turn is writing", () => {
    expect(turnDoing([{ type: "tool", tool: { id: "c", name: "forge", result: "ok" } }], t)).toBeNull();
    expect(turnDoing([{ type: "text", text: "Đang trả lời" }], t)).toBeNull(); // i18n-allow: a production ask or reply replayed as the test case
  });
});
