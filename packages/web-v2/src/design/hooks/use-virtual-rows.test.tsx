// @vitest-environment jsdom
//
// ISS-1264 — the one hook that imports @tanstack/react-virtual: what it hands back is plain numbers,
// the row holding focus is among them, and the library is declared at the exact version the issue
// pinned and imported nowhere else but under src/design.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("is declared at exactly 3.14.15, with no range", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(manifest.dependencies["@tanstack/react-virtual"]).toBe("3.14.15");
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
    <div ref={virtual.scrollerRef} data-testid="scroller" {...virtual.scrollerEvents}>
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

function Jump({ to }: { to: number }) {
  const virtual = useVirtualRows({ count: 1000, estimateSize: ROW, overscan: 2 });
  return (
    <>
      <button type="button" onClick={() => virtual.focusRow(to)}>
        jump
      </button>
      <div ref={virtual.scrollerRef} data-testid="scroller" {...virtual.scrollerEvents}>
        {virtual.rows.map((row) => (
          <button type="button" key={row.key} ref={virtual.measureRow} data-index={row.index}>
            {`row ${row.index}`}
          </button>
        ))}
      </div>
    </>
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

  it("aims again at the last row when a scroll comes to rest at the end of rows only estimated", async () => {
    // Every row is measured at twice the height it was estimated at, so the end moves once they are.
    restore();
    restore = stubLayout((el) => {
      if (el.dataset.testid === "scroller") return { width: 300, height: FRAME };
      if (el.dataset.index !== undefined) return { width: 300, height: ROW * 2 };
      return undefined;
    });
    render(<Rows count={1000} />);
    await act(async () => {});
    const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]') as HTMLElement;
    const total = () => Number(document.querySelector('[data-testid="total"]')?.textContent);
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => total() });

    await act(async () => {
      scroller.scrollTop = total() - FRAME;
      fireEvent.scroll(scroller);
    });
    await act(async () => {
      await new Promise((later) => setTimeout(later, 100));
    });

    expect(drawn()).toContain(999);
    expect(scroller.scrollTop).toBeGreaterThanOrEqual(total() - FRAME - 1);
  });

  it("does not move a scroll that has not come to rest at the end", async () => {
    render(<Rows count={1000} />);
    await act(async () => {});
    const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]') as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1000 * ROW });
    await act(async () => {
      scroller.scrollTop = ROW * 400;
      fireEvent.scroll(scroller);
    });
    await act(async () => {
      await new Promise((later) => setTimeout(later, 100));
    });
    expect(scroller.scrollTop).toBe(ROW * 400);
    expect(drawn()).not.toContain(999);
  });

  it("draws and focuses the row it is asked for when the scroll aimed at it does not move the scroller", async () => {
    const still = vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => {});
    render(<Jump to={700} />);
    await act(async () => {});
    expect(drawn()).not.toContain(700);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "jump" })));
    expect(drawn()).toContain(700);
    expect((document.activeElement as HTMLElement).dataset.index).toBe("700");
    still.mockRestore();
  });

  it("aims a scroll at the last row on End, without moving focus, and leaves Shift+End and a text field's End to the browser", async () => {
    render(
      <>
        <Rows count={1000} />
        <input aria-label="elsewhere" />
      </>,
    );
    await act(async () => {});
    const first = document.querySelector<HTMLElement>('[data-index="0"]') as HTMLElement;
    act(() => first.focus());
    const aimed = vi.spyOn(Element.prototype, "scrollTo");
    expect(fireEvent.keyDown(first, { key: "End", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(screen.getByLabelText("elsewhere"), { key: "End" })).toBe(true);
    expect(aimed).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(first, { key: "End" })).toBe(false);
    expect(aimed).toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
    aimed.mockRestore();
  });
});
