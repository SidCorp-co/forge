// @vitest-environment jsdom
//
// ISS-1264 — the one hook that imports @tanstack/react-virtual: what it hands back is plain numbers,
// the row holding focus is among them, and the library is declared at the exact version the issue
// pinned and imported nowhere else but under src/design.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubLayout } from "@/test-support/layout";
import { useVirtualRows } from "./use-virtual-rows";

const ROOT = resolve(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("the library behind the design layer", () => {
  it("is declared at exactly 3.14.13, with no range", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(manifest.dependencies["@tanstack/react-virtual"]).toBe("3.14.13");
  });

  it("is imported by nothing outside src/design, and by this one hook inside it", () => {
    const importers = sources(ROOT)
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
      .filter((file) => /from\s+["']@tanstack\/react-virtual/.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(importers).toEqual(["design/hooks/use-virtual-rows.ts"]);
  });
});

const FRAME = 300;
const ROW = 50;
let restore: () => void;
beforeEach(() => {
  restore = stubLayout((el) => {
    if (el.dataset.testid === "scroller") return { width: 300, height: FRAME };
    if (el.dataset.index !== undefined) return { width: 300, height: ROW };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  restore();
});

function Rows({ count, enabled = true }: { count: number; enabled?: boolean }) {
  const virtual = useVirtualRows({ count, estimateSize: ROW, enabled, overscan: 2 });
  return (
    <div ref={virtual.scrollerRef} data-testid="scroller" {...virtual.trackFocus}>
      <output data-testid="total">{virtual.totalSize}</output>
      <output data-testid="after">{virtual.gapAfter}</output>
      {virtual.rows.map((row) => (
        <button type="button" key={row.key} ref={virtual.measureRow} data-index={row.index} data-gap={row.gapBefore}>
          {`row ${row.index}`}
        </button>
      ))}
    </div>
  );
}

const drawn = () => Array.from(document.querySelectorAll<HTMLElement>("[data-index]")).map((el) => Number(el.dataset.index));

describe("useVirtualRows", () => {
  it("hands back the rows in view with the height of all of them, and what is not drawn after", async () => {
    render(<Rows count={1000} />);
    await act(async () => {});
    expect(drawn().length).toBeLessThan(15);
    expect(drawn()[0]).toBe(0);
    const total = Number(document.querySelector('[data-testid="total"]')?.textContent);
    const after = Number(document.querySelector('[data-testid="after"]')?.textContent);
    expect(total).toBe(1000 * ROW);
    expect(after + drawn().length * ROW).toBe(total);
  });

  it("hands back nothing at all when it is not enabled", async () => {
    render(<Rows count={1000} enabled={false} />);
    await act(async () => {});
    expect(drawn()).toEqual([]);
    expect(document.querySelector('[data-testid="total"]')?.textContent).toBe("0");
  });

  it("measures the gap before a row that is drawn apart from the rest, so spacers can fill it", async () => {
    render(<Rows count={1000} />);
    await act(async () => {});
    const held = document.querySelector<HTMLElement>('[data-index="1"]') as HTMLElement;
    act(() => held.focus());
    const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]') as HTMLElement;
    await act(async () => {
      scroller.scrollTop = ROW * 600;
      fireEvent.scroll(scroller);
    });
    expect(drawn()).toContain(1);
    const far = document.querySelector<HTMLElement>(`[data-index="${drawn().find((i) => i > 500)}"]`) as HTMLElement;
    expect(Number(far.dataset.gap)).toBeGreaterThan(ROW * 100);
  });
});
