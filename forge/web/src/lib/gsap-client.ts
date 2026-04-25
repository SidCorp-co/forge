'use client';

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// ScrollTrigger.register touches window.matchMedia (jsdom + Node SSR don't
// have it), so registration is gated to the browser. Consumers also call
// gsap.registerPlugin(ScrollTrigger) inside their useEffect — registerPlugin
// is idempotent — to close any chunk-evaluation race where the side-effect
// here didn't run before a scrollTrigger config was parsed (root cause of
// ISS-262 / ISS-269).
if (typeof window !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger);
}

export { gsap, ScrollTrigger };
