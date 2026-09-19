
/** Base document title — the favicon/title indicator only PREFIXES this. */
const BASE_TITLE = "Forge";
const BADGE_COLOR = "#F15A2B";
/** A contrast ring around the dot so it reads against a dark favicon too. */
const RING_COLOR = "#FFFFFF";

let originalHref: string | null = null;
/** Pre-rendered data-URL variants, built lazily once the base image loads. */
let plainDataUrl: string | null = null;
let badgedDataUrl: string | null = null;
/** Whether we've kicked off the async base-image load yet. */
let buildStarted = false;
let pendingShow = false;

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
    };
    img.src = originalHref ?? link.href;
  } catch {
    // Image construction can throw in exotic envs — degrade silently.
  }
}

export function setFaviconBadge(show: boolean): void {
  if (typeof document === "undefined") return;
  try {
    pendingShow = show;
    if (!buildStarted) buildVariants();
    // If the variants are already built, apply immediately; otherwise the
    // image onload handler will pick up `pendingShow`.
    applyPending();
  } catch {
  }
}

/**
 * Prefix the document title with the open count, e.g. `(3) Forge`, capping at
 * `(99+)`. `count <= 0` restores the bare base title. SSR-safe; never throws.
 */
export function setTitleOpenCount(count: number): void {
  if (typeof document === "undefined") return;
  try {
    document.title = count > 0 ? `(${count > 99 ? "99+" : count}) ${BASE_TITLE}` : BASE_TITLE;
  } catch {
    // Assigning document.title can't normally throw, but stay defensive.
  }
}
