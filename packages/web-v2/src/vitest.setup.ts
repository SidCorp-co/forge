import { configure } from '@testing-library/dom';
import { afterEach } from 'vitest';

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

// cm:why sonner keeps its toasts in one module-level store and replays every undismissed one to the
// next Toaster that mounts, so a toast raised in one test was found by the next test's queries
if (typeof window !== 'undefined') {
  afterEach(async () => {
    const { toast } = await import('sonner');
    toast.dismiss();
  });
}
