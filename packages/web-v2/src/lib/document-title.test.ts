// @vitest-environment jsdom
//
// ISS-1229 r43, judge-120: the bell wrote "(N) Forge" over the whole tab title, so a page could not name
// itself there, and its count ran to "1004".
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setTitleOpenCount } from "@/lib/notifications/favicon";
import { documentTitle, shortCount, usePageTitle } from "./document-title";

afterEach(() => {
  cleanup();
  setTitleOpenCount(0);
});

describe("the tab title", () => {
  it("names the page, then the app, with the open count ahead of both", () => {
    expect(documentTitle(null, 0)).toBe("Forge");
    expect(documentTitle("This issue is not in Desk", 0)).toBe("This issue is not in Desk · Forge");
    expect(documentTitle("This issue is not in Desk", 3)).toBe("(3) This issue is not in Desk · Forge");
  });

  it("keeps the page's name when the bell's count changes, in either order", () => {
    const page = renderHook(() => usePageTitle("This issue is not in Desk"));
    setTitleOpenCount(1004);
    expect(document.title).toBe("(99+) This issue is not in Desk · Forge");
    setTitleOpenCount(0);
    expect(document.title).toBe("This issue is not in Desk · Forge");
    page.unmount();
    setTitleOpenCount(2);
    expect(document.title).toBe("(2) Forge");
  });
});

describe("a count as the bell shows it", () => {
  it("is the number up to 99 and 99+ past it, never longer than three characters", () => {
    expect(shortCount(1)).toBe("1");
    expect(shortCount(99)).toBe("99");
    expect(shortCount(100)).toBe("99+");
    expect(shortCount(1004)).toBe("99+");
  });
});
