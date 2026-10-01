import { configure } from '@testing-library/dom';

configure({ asyncUtilTimeout: 10_000 });

// cm:why jsdom has no matchMedia, and the toast lane (sonner) reads it on mount, so every jsdom test that renders the ToastProvider threw before its first assertion; a test that needs a media query to match still installs its own
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
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
