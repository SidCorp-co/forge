/**
 * A ref callback that focuses its element once it mounts: a field opened by an act, ready to type in.
 * One function for every caller, so React never sees a new callback and focuses again on a re-render.
 */
export const focusOnMount = (el: HTMLElement | null): void => {
  el?.focus();
};
