import '@testing-library/jest-dom/vitest';

// jsdom doesn't ship matchMedia. ScrollTrigger.register touches it during
// gsap.registerPlugin() at module load (forge/web/src/lib/gsap-client.ts) —
// stub it on both window and globalThis so any test that imports the
// gsap-client (directly or transitively) doesn't throw.
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
