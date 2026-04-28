import '@testing-library/jest-dom/vitest';

// jsdom doesn't ship matchMedia. framer-motion's `useInView` reads it on
// client-only paths; stub on both window and globalThis so component tests
// that import landing/trust components don't throw.
const matchMediaStub = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
});

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: matchMediaStub });
}
if (typeof globalThis !== 'undefined') {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, configurable: true, value: matchMediaStub });
}
