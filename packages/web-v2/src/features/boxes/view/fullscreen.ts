// The browser's full screen for a box's screen (ISS-1325): the Fullscreen API on the element, under
// its prefixed name where only that is offered (Safari on an iPad). Where the browser has none, or
// refuses it (iOS Safari on a phone, a press too old to count), the caller fills the viewport instead.

type FullscreenTarget = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
};
type Lockable = ScreenOrientation & { lock?: (orientation: "portrait" | "landscape") => Promise<void> };

const doc = () => document as FullscreenDocument;

/** The events a change in or out of full screen fires on the document. */
export const FULLSCREEN_CHANGE = ["fullscreenchange", "webkitfullscreenchange"] as const;

/** The element in the browser's full screen now, if any. */
export const fullscreenElement = (): Element | null => doc().fullscreenElement ?? doc().webkitFullscreenElement ?? null;

/** Whether this browser offers element full screen at all. */
export const canFullscreen = (): boolean => !!(doc().fullscreenEnabled ?? doc().webkitFullscreenEnabled);

/**
 * Ask the browser to show `el` full screen; true once it did. A phone's screen is turned to the box's
 * own shape where the browser lets a page lock it (Android Chrome in full screen), so an upright box
 * fills a phone held upright.
 */
export async function enterFullscreen(el: HTMLElement, upright: boolean): Promise<boolean> {
  const target = el as FullscreenTarget;
  const request = target.requestFullscreen?.bind(target) ?? target.webkitRequestFullscreen?.bind(target);
  if (!request) return false;
  try {
    await request();
  } catch {
    return false;
  }
  const orientation: Lockable | undefined = typeof screen === "undefined" ? undefined : screen.orientation;
  orientation?.lock?.(upright ? "portrait" : "landscape").catch(() => undefined);
  return true;
}

/** Leave the browser's full screen, if the page is in it. */
export function leaveFullscreen(): void {
  if (!fullscreenElement()) return;
  const exit = doc().exitFullscreen?.bind(doc()) ?? doc().webkitExitFullscreen?.bind(doc());
  void Promise.resolve(exit?.()).catch(() => undefined);
}
