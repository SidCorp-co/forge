/**
 * One live region for every wait before a failed read's Retry, and each read's wait told in it once as it starts and
 * once as it ends, however many places show it (ISS-1229 r54, judge-168: a read shown in three places was told three
 * times each way, and a sheet opened mid-wait told it again). The places register; the read is what is told.
 */

export const WAIT_OVER = "You can retry now.";

const REGION_ID = "fg-wait-announcer";
/** How long a sentence stays in the region once said: long enough to be read out, short enough to leave no trail. */
const KEPT_FOR_MS = 7_000;
/** The same sentence again this soon is one telling: two reads refused together end together. */
const SAME_WITHIN_MS = 1_500;
/** A region stood up for this sentence is given a moment to be found before anything is said in it. */
const FIRST_SAID_AFTER_MS = 100;

interface Wait {
  at: number;
  places: number;
  told: boolean;
}

const waits = new Map<string, Wait>();
let lastSaid: { text: string; at: number } | null = null;
let stoodAt = 0;

function region(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const standing = document.getElementById(REGION_ID);
  if (standing) return standing;
  stoodAt = Date.now();
  const el = document.createElement("div");
  el.id = REGION_ID;
  el.setAttribute("role", "log");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-relevant", "additions");
  el.setAttribute("data-testid", "wait-announcer");
  Object.assign(el.style, {
    position: "absolute", width: "1px", height: "1px", margin: "-1px", padding: "0",
    overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: "0",
  });
  document.body.appendChild(el);
  return el;
}

function say(text: string): void {
  const now = Date.now();
  if (lastSaid && lastSaid.text === text && now - lastSaid.at < SAME_WITHIN_MS) return;
  lastSaid = { text, at: now };
  const el = region();
  if (!el) return;
  const put = () => {
    const line = document.createElement("p");
    line.textContent = text;
    el.appendChild(line);
    setTimeout(() => line.remove(), KEPT_FOR_MS);
  };
  const settling = stoodAt + FIRST_SAID_AFTER_MS - now;
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
  lastSaid = null;
  if (typeof document !== "undefined") document.getElementById(REGION_ID)?.remove();
}
