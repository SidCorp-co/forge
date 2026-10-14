// What a test gives an element that jsdom cannot: a size. A test names the sizes it asserts wiring for
// and never real coordinates; where an element sits on screen is the browser walk's to prove.

export interface Box {
  width?: number;
  height?: number;
}

type Measure = (element: HTMLElement) => Box | undefined;

const SIZE_PROPS = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const;

/**
 * Makes every element measure as `measure` says (an element it returns nothing for stays at 0), and
 * lets `scrollTo` move a scroller the way a browser does: set `scrollTop`, then fire `scroll`.
 * Returns what puts the prototypes back.
 */
export function stubLayout(measure: Measure): () => void {
  const sizeOf = (element: Element) => measure(element as HTMLElement) ?? {};
  const restore: Array<() => void> = [];

  for (const prop of SIZE_PROPS) {
    const axis = prop.endsWith("Width") ? "width" : "height";
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return sizeOf(this)[axis] ?? 0;
      },
    });
    restore.push(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    });
  }

  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const { width = 0, height = 0 } = sizeOf(this);
    return { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({}) };
  };
  restore.push(() => {
    Element.prototype.getBoundingClientRect = rect;
  });

  const scrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    const top = typeof options === "object" ? options.top : undefined;
    if (top !== undefined) {
      this.scrollTop = top;
      this.dispatchEvent(new Event("scroll"));
    }
  } as typeof Element.prototype.scrollTo;
  restore.push(() => {
    Element.prototype.scrollTo = scrollTo;
  });

  return () => {
    for (const undo of restore.reverse()) undo();
  };
}
