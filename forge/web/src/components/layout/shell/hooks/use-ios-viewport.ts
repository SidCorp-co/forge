'use client';

import { useEffect, useRef } from 'react';

export function useIosViewport() {
  const shellRef = useRef<HTMLDivElement>(null);

  // Resize Shell to match visualViewport when iOS keyboard opens/closes.
  // position:fixed elements don't shrink when the keyboard appears, so
  // we manually set the height to visualViewport.height.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      window.scrollTo(0, 0);
      if (shellRef.current) {
        shellRef.current.style.height = `${vv.height}px`;
      }
    };
    // Also handle scroll (iOS scrolls the visual viewport when keyboard opens)
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }, []);

  // Block touchmove on the document except inside scrollable containers.
  // Uses capture phase + touchstart tracking for reliable iOS prevention.
  useEffect(() => {
    const SCROLLABLE_TAGS = new Set(['DIV', 'NAV', 'SECTION', 'UL', 'OL']);

    function findScrollableAncestor(el: HTMLElement | null): HTMLElement | null {
      while (el && el !== document.documentElement) {
        if (SCROLLABLE_TAGS.has(el.tagName)) {
          const style = window.getComputedStyle(el);
          const oy = style.overflowY;
          if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
            return el;
          }
        }
        el = el.parentElement;
      }
      return null;
    }

    let scrollableTarget: HTMLElement | null = null;
    let startY = 0;

    function onTouchStart(e: TouchEvent) {
      const target = e.target as HTMLElement | null;
      scrollableTarget = findScrollableAncestor(target);
      startY = e.touches[0].clientY;
    }

    function onTouchMove(e: TouchEvent) {
      if (!scrollableTarget) {
        e.preventDefault();
        return;
      }
      // Prevent overscroll at boundaries of the scrollable container
      const dy = e.touches[0].clientY - startY;
      const { scrollTop, scrollHeight, clientHeight } = scrollableTarget;
      const atTop = scrollTop <= 0 && dy > 0;
      const atBottom = scrollTop + clientHeight >= scrollHeight && dy < 0;
      if (atTop || atBottom) {
        e.preventDefault();
      }
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchmove', onTouchMove, true);
    };
  }, []);

  return shellRef;
}
