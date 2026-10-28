/**
 * One live region for every wait before a failed read's Retry, and each read's wait told in it once as it starts and
 * once as it ends, however many places show it (ISS-1229 r54, judge-168: a read shown in three places was told three
 * times each way, and a sheet opened mid-wait told it again). The places register; the read is what is told.
 */

export const WAIT_OVER = "You can retry now.";

const REGION = "wait-announcer";
/** How long a sentence stays in the region once said: long enough to be read out, short enough to leave no trail. */
const KEPT_FOR_MS = 7_000;
/** A region stood up for this sentence is given a moment to be found before anything is said in it. */
const FIRST_SAID_AFTER_MS = 100;

interface Wait {
  at: number;
  places: number;
  told: boolean;
}

const waits = new Map<string, Wait>();
const stoodAt = new WeakMap<HTMLElement, number>();

/** The region a screen reader can hear now: inside the open modal dialog, which confines it, else on the page (r54 review). */
function region(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const host = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].at(-1) ?? document.body;
  const standing = [...host.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.testid === REGION);
  if (standing) return standing;
  const el = document.createElement("div");
  el.setAttribute("role", "log");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-relevant", "additions");
  el.setAttribute("data-testid", REGION);
  Object.assign(el.style, {
    position: "absolute", width: "1px", height: "1px", margin: "-1px", padding: "0",
    overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: "0",
  });
  host.appendChild(el);
  stoodAt.set(el, Date.now());
  return el;
}

function say(text: string): void {
  const el = region();
  if (!el) return;
  const put = () => {
    const line = document.createElement("p");
    line.textContent = text;
    el.appendChild(line);
    setTimeout(() => line.remove(), KEPT_FOR_MS);
  };
  const settling = (stoodAt.get(el) ?? 0) + FIRST_SAID_AFTER_MS - Date.now();
  if (settling > 0) setTimeout(put, settling);
  else put();
}

/**
 * A place showing the wait of the read `read`, ending at `at`: the first place to show it tells its start, and its
 * end is told once if any place still shows it then. Every other place, mounted before or mid-wait, tells nothing.
 * Answers how the place stops showing it.
 */
export function showWait(read: string, at: number, started: string): () => void {
  region();
  let wait = waits.get(read);
  if (!wait) {
    wait = { at, places: 0, told: false };
    waits.set(read, wait);
  }
  const shown = wait;
  shown.places += 1;
  const left = at - Date.now();
  if (!shown.told && left > 0) {
    shown.told = true;
    say(started);
    setTimeout(() => {
      if (shown.places > 0) say(WAIT_OVER);
      waits.delete(read);
    }, left);
  }
  return () => {
    shown.places -= 1;
    if (shown.places === 0 && Date.now() >= shown.at) waits.delete(read);
  };
}

/** Forgets every wait and the region: a test's fresh page. */
export function forgetWaits(): void {
  waits.clear();
  if (typeof document !== "undefined") for (const el of document.querySelectorAll(`[data-testid="${REGION}"]`)) el.remove();
}
