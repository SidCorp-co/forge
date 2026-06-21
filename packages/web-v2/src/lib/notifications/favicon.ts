// Favicon + document-title unread indicator (ISS-523) — the always-visible
// analogue of the toast/browser channels.
//
// The native browser-notification channel (lib/notifications/browser) is gated
// on the tab being BACKGROUNDED, so a user watching the page never sees a
// native notification (by design — a focused tab gets the in-app toast). That
// leaves no persistent "you have unread" signal on the tab itself. This module
// fills that gap: it overlays a small dot on the favicon and prefixes the
// document title with the unread count, both visible whether or not the tab is
// focused.
//
// Driven by the same `useUnreadCount()` the header bell uses (see
// features/notifications/use-unread-indicator), so the favicon and the bell can
// never disagree. Everything is SSR-safe and degrades to a silent no-op when the
// DOM / canvas is unavailable; callers never need to guard and nothing here ever
// throws.

/** Base document title — the favicon/title indicator only PREFIXES this. */
const BASE_TITLE = "Forge";
/** Badge dot color — the flame accent (`--flame-500`); kept in sync by hand
 *  since a canvas fill can't read a CSS custom property. */
const BADGE_COLOR = "#F15A2B";
/** A contrast ring around the dot so it reads against a dark favicon too. */
const RING_COLOR = "#FFFFFF";

/** The original favicon href, captured on first use so `show=false` can restore
 *  it exactly (Next injects `/icon.png?<hash>`). */
let originalHref: string | null = null;
/** Pre-rendered data-URL variants, built lazily once the base image loads. */
let plainDataUrl: string | null = null;
let badgedDataUrl: string | null = null;
/** Whether we've kicked off the async base-image load yet. */
let buildStarted = false;
/** The most recently requested badge state — applied once the variants exist,
 *  so a call made before the image loads still takes effect on load. */
let pendingShow = false;

/** Locate the existing `<link rel="icon">`, creating one if absent. Returns null
 *  when there's no document (SSR) or `<head>` is unavailable. */
function getIconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    const head = document.head;
    if (!head) return null;
    link = document.createElement("link");
    link.rel = "icon";
    head.appendChild(link);
  }
  return link;
}

/** Apply the pending badge state to the icon link, given the variants exist. */
function applyPending(): void {
  const link = getIconLink();
  if (!link) return;
  if (pendingShow) {
    if (badgedDataUrl) link.href = badgedDataUrl;
  } else {
    // Prefer the original href (pixel-perfect); fall back to the plain variant.
    link.href = originalHref ?? plainDataUrl ?? link.href;
  }
}

/** Lazily render the plain + badged favicon variants off the same-origin base
 *  image. The base `/icon.png` is same-origin so the canvas is NOT tainted and
 *  `toDataURL()` is safe; if a future CDN-hosted icon taints it, the SecurityError
 *  is swallowed and the indicator degrades to a no-op. */
function buildVariants(): void {
  if (buildStarted) return;
  buildStarted = true;
  const link = getIconLink();
  if (!link) return;
  if (originalHref === null) originalHref = link.href || null;

  try {
    const img = new Image();
    // Same-origin already, but be explicit so a CORS-enabled CDN stays untainted.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 64;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return; // no 2d context → stay on the static favicon
        // Plain variant — the base image scaled to the canvas.
        ctx.drawImage(img, 0, 0, size, size);
        plainDataUrl = canvas.toDataURL("image/png");
        // Badged variant — same base plus a ringed dot in the top-right corner.
        const r = size * 0.2;
        const cx = size - r - 2;
        const cy = r + 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r + size * 0.05, 0, Math.PI * 2);
        ctx.fillStyle = RING_COLOR;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = BADGE_COLOR;
        ctx.fill();
        badgedDataUrl = canvas.toDataURL("image/png");
        // Image may have loaded after the caller asked for a state — apply it now.
        applyPending();
      } catch {
        // canvas / toDataURL can throw (tainted canvas, OOM) — degrade silently.
      }
    };
    img.onerror = () => {
      // base image failed to load — stay on the static favicon, no throw.
    };
    img.src = originalHref ?? link.href;
  } catch {
    // Image construction can throw in exotic envs — degrade silently.
  }
}

/**
 * Show or hide the unread dot on the favicon. Idempotent and safe to call on
 * every unread-count change. SSR-safe; never throws. Degrades to a no-op when
 * there's no document, no canvas 2d context, or the base image can't load.
 */
export function setFaviconBadge(show: boolean): void {
  if (typeof document === "undefined") return;
  try {
    pendingShow = show;
    if (!buildStarted) buildVariants();
    // If the variants are already built, apply immediately; otherwise the
    // image onload handler will pick up `pendingShow`.
    applyPending();
  } catch {
    // Any DOM access can throw in exotic envs — degrade silently.
  }
}

/**
 * Prefix the document title with the unread count, e.g. `(3) Forge`, capping at
 * `(99+)`. `count <= 0` restores the bare base title. SSR-safe; never throws.
 */
export function setTitleUnread(count: number): void {
  if (typeof document === "undefined") return;
  try {
    document.title = count > 0 ? `(${count > 99 ? "99+" : count}) ${BASE_TITLE}` : BASE_TITLE;
  } catch {
    // Assigning document.title can't normally throw, but stay defensive.
  }
}
