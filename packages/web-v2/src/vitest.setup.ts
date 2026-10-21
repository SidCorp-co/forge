import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

configure({ asyncUtilTimeout: 5_000 });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// cm:why jsdom has no matchMedia, and the toast lane (sonner) and next-themes read it on mount; a
// test that needs a media query to match installs its own
// A file declaring `@vitest-environment node` has no window; nothing below is for it.
const inBrowserLike = typeof window !== 'undefined';

if (inBrowserLike && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// cm:why jsdom has no ResizeObserver, and the floating-ui positioner behind every base-ui popup
// observes its anchor with one
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// cm:why jsdom implements no scrolling, and the router resets the scroll on every navigation a
// route test makes
if (inBrowserLike) window.scrollTo = () => {};
