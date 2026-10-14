// jsdom has no layout and no `ResizeObserver`. This one reports what the element measures on `observe`
// and when a test says it resized; unstubbed, that is the 0 a browser reports for an element with no box.

type Target = Element;

const live = new Set<MeasuredResizeObserver>();

function entryOf(target: Target): ResizeObserverEntry {
  const rect = target.getBoundingClientRect();
  const size = { inlineSize: rect.width, blockSize: rect.height } as ResizeObserverSize;
  return {
    target,
    contentRect: rect,
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size],
  };
}

class MeasuredResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Target>();

  constructor(private readonly callback: ResizeObserverCallback) {
    live.add(this);
  }

  observe(target: Target): void {
    this.targets.add(target);
    queueMicrotask(() => {
      if (this.targets.has(target)) this.deliver([target]);
    });
  }

  unobserve(target: Target): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    live.delete(this);
  }

  /** Reports the targets this observer is watching among `changed`, or all of them. */
  deliver(changed?: readonly Target[]): void {
    const entries = [...this.targets]
      .filter((target) => changed === undefined || changed.includes(target))
      .map(entryOf);
    if (entries.length > 0) this.callback(entries, this);
  }
}

/** Tells every observer watching `target` (or, with none named, every target) that it changed size. */
export function notifyResize(target?: Target): void {
  for (const observer of [...live]) observer.deliver(target ? [target] : undefined);
}

/** Puts the measured observer on `globalThis` where a runtime with a window has none. */
export function installResizeObserver(): void {
  if (typeof window === "undefined" || "ResizeObserver" in window) return;
  globalThis.ResizeObserver = MeasuredResizeObserver;
}
