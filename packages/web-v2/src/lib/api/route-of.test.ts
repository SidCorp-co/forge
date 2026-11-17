import { describe, expect, it } from "vitest";
import { routeOf } from "./route-of";

describe("routeOf", () => {
  it("fills each param encoded and drops the /api prefix the client adds", () => {
    expect(routeOf("/api/boxes/:id/ticket", { id: "a b/c" })).toBe("/boxes/a%20b%2Fc/ticket");
  });

  it("refuses a param the route names and the caller left out, by its name", () => {
    expect(() => routeOf("/api/rooms/:id/items/:itemId", { id: "r1" })).toThrow("/api/rooms/:id/items/:itemId needs :itemId");
  });
});
