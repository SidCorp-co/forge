// The requirement page and peek as the strip tests read them (ISS-461, REQ-35 BC-5, BC-6, BC-13): a
// fake core for the reads the page makes, the page and the peek over the shared fixture, and the
// checks each test plants against: what hides the strip at some width, what in the strip is not the
// lifecycle's or a verdict's own, and what outside it says a second waiting-on or verified count.

import { BC_VERDICT_LABELS, BC_VERDICTS, type BcVerdict, criteriaCoverageOf, REQUIREMENT_LIFECYCLE, REQUIREMENT_STATE_LABELS, type RequirementState } from "@forge/contracts/requirements";
import { QueryClient } from "@tanstack/react-query";
import { within } from "@testing-library/react";
import { statusReading } from "@/design";
import { RequirementPage } from "@/features/requirements/components/requirement-detail";
import { RequirementPeek } from "@/features/requirements/components/requirement-peek";
import type { RequirementDetail } from "@/features/requirements/types";
import { productCopy } from "@/lib/i18n/product-copy";
import { saidView } from "@/lib/i18n/said";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { forecastWait, RULE, say } from "@/test/said";
import { reqDetail } from "@/test/vi-chrome-requirements";

export const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";
export const t = productCopy("en");

const decision = { id: "d1", target: { scope: "requirement", id: "t-d1", key: "REQ-1", title: null }, intent: "decision", body: null, format: "markdown", decision: { decision: "Keep the clinic name", reason: "asked" }, parentId: null, author: { id: "u1", name: "Dana", agency: "human" }, withheld: false, edited: false, createdAt: "2026-10-07T10:00:00Z", updatedAt: "2026-10-07T10:00:00Z", datedAhead: null };

/** A forecast that is paused on somebody the standing does not name: the second waiting-on the rail used to print. */
const ODIN = say("standing.who.named", { name: "Odin Forecast" });
const stamp = { label: "forecast" as const, asOf: "2026-10-07T12:00:00Z" };
const paused = { ...stamp, kind: "paused" as const, ...forecastWait(ODIN, say("standing.act.cut", { v: "0.1.0", more: null }), RULE), ref: null, since: null, late: null };
const forecast = {
  ...stamp,
  scope: "requirement",
  anchor: { at: "2026-10-07T00:00:00.000Z", event: { key: "forecast.event.none" } },
  moved: null,
  key: "REQ-1",
  title: "t",
  progress: { total: 2, shipped: 1, awaitingRelease: 0, toDo: 1 },
  forecast: paused,
  next: null,
  delivery: { ...stamp, landing: paused, release: null, inHands: null, shipped: null },
};

export function core() {
  return fakeCore((c: Call) => {
    if (c.path.startsWith(`/projects/${PROJECT}/requirements/REQ-1/decisions`)) return { body: { decisions: [decision], answers: [], by: "people", folded: 0 } };
    if (c.path.includes("/comments")) return { body: { comments: [], returned: 0 } };
    if (c.path === `/projects/${PROJECT}/forecast/requirements/REQ-1`) return { body: forecast };
    return HANG;
  });
}

export const client = (d: RequirementDetail = reqDetail) => {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  c.setQueryData(["requirement", PROJECT, "REQ-1"], d);
  return c;
};

export function page(tab: "overview" | "criteria" | "revisions" | "decisions" | "activity" | "mockups" | "memory", d: RequirementDetail = reqDetail) {
  renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab={tab} onTab={() => {}} />, client(d));
}

const row = (code: string, verdict: BcVerdict) => ({ code, body: `Tieu chi ${code}`, verdict, issues: [], uncoveredReason: null });

/** Every verdict at once: one passing, so k is 1 of 5 whatever a count that also took stale or not judged would say. */
export const mixed = {
  ...reqDetail,
  standing: { ...reqDetail.standing, coverage: [row("BC-1", "passing"), row("BC-2", "failing"), row("BC-3", "stale"), row("BC-4", "not_judged"), row("BC-5", "gap")] },
} as RequirementDetail;

// ── what hides an element at some width ─────────────────────────────────────────────────────────

/** A breakpoint or container variant: `sm:`, `max-md:`, `min-[400px]:`, `@lg:`. */
const RESPONSIVE = /^(max-|min-)?(sm|md|lg|xl|2xl|\[[^\]]+\])$|^@/;
/** A variant that applies at phone width (390): none, or a `max-` one. `sm:`, `md:`, `min-*` start wider. */
const AT_PHONE = (variants: readonly string[]) => variants.every((v) => !RESPONSIVE.test(v) || v.startsWith("max-"));
/** A utility that takes an element out of sight: display, visibility, zero size or opacity, clipped or pushed off-screen. */
const HIDING =
  /^(hidden|sr-only|invisible|collapse|opacity-0|(size|w|h|max-w|max-h)-0|(size|w|h|max-w|max-h)-px|(size|w|h|max-w|max-h)-0\.5|scale(-[xy])?-0|-?(inset|inset-[xy]|left|right|top|bottom|start|end)-\[?-?\d{4,}|-?translate-[xy]-(full|\[-?\d{3,}.*\])|-(m|mt|mb|ml|mr|mx|my|ms|me)-(\[\d{3,}.*\]|\d{3,})|clip-.+|\[(display|visibility|clip|clip-path|opacity|width|height|max-height|max-width|transform)[:_].*\]|text-\[0[^\]]*\]|grid-rows-\[0fr\])$/;
/** An arbitrary size: `h-[0px]`, `max-h-[0.1rem]`, `size-[2%]`. */
const ARBITRARY_SIZE = /^(size|w|h|max-w|max-h)-\[(-?[\d.]+)(px|rem|em|%|vh|vw|svh|dvh|lvh)?\]$/;
/** A size a 390-wide phone cannot show a strip in: under 4px. */
const tooSmall = (value: number, unit: string | undefined) => (unit === "rem" || unit === "em" ? value * 16 : value) < 4;
/** A height or size cap on an element that also clips what overflows it: it can cut the strip off. */
const CAPS = /^(size|h|max-h)-/;
const CLIPS = /^(overflow|overflow-y|overflow-x)-(hidden|clip)$|^contain-(size|strict)$/;
/** What a variant may change across widths inside the strip, or on a phone around it: space and layout only, never what shows. */
const SPACING = /^(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-/;
const LAYOUT = /^(grid-cols-|col-span-|flex-(row|col|wrap)|items-|justify-|order-|border|rounded|text-(left|center|right))/;

/** Why an inline style takes `el` out of sight, or null. */
function styleHides(el: HTMLElement): string | null {
  const s = el.style;
  if (!s) return null;
  const px = (v: string) => (v ? (/rem$/.test(v) ? Number.parseFloat(v) * 16 : Number.parseFloat(v)) : Number.NaN);
  const small = [s.width, s.height, s.maxHeight, s.maxWidth].some((v) => v !== "" && px(v) < 4);
  const offscreen = [s.left, s.top, s.marginTop, s.marginLeft, s.right].some((v) => v !== "" && px(v) <= -500);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0" || small || offscreen || s.clipPath !== "" || s.clip !== "" || /scale\(0|translate[XY]?\(-\d{3,}/.test(s.transform)) {
    return `the style "${el.getAttribute("style")}"`;
  }
  return null;
}

/** Why `el` is out of sight at some width, or null: its attribute, its inline style, or a class at any breakpoint. */
function hiddenBy(el: Element, inside: boolean): string | null {
  const h = el as HTMLElement;
  if (h.hidden || el.hasAttribute("hidden")) return "the hidden attribute";
  const styled = styleHides(h);
  if (styled) return styled;
  const tokens = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).map((token) => {
    const parts = token.replace(/^!/, "").split(":");
    return { token, base: (parts.pop() ?? "").replace(/^!/, ""), variants: parts };
  });
  for (const { token, base, variants } of tokens) {
    if (HIDING.test(base)) return `the class "${token}"`;
    const sized = ARBITRARY_SIZE.exec(base);
    if (sized && tooSmall(Number(sized[2]), sized[3])) return `the class "${token}", a size no strip fits in`;
    const breakpoint = variants.some((v) => RESPONSIVE.test(v));
    if (inside && breakpoint && !SPACING.test(base)) return `the class "${token}", which changes what shows at one width`;
    if (!inside && breakpoint && AT_PHONE(variants) && !SPACING.test(base) && !LAYOUT.test(base)) return `the class "${token}", which changes it at phone width`;
  }
  // a cap and a clip on one element, at whatever widths each holds, can cut off whatever it holds
  const cap = tokens.find((t) => CAPS.test(t.base) && !/^(h|size)-(full|auto|fit|max|min|screen|dvh|svh|lvh)$/.test(t.base) && !t.base.startsWith("max-h-none"));
  const clip = tokens.find((t) => CLIPS.test(t.base));
  if (cap && clip && (AT_PHONE(cap.variants) || AT_PHONE(clip.variants))) return `the classes "${cap.token}" and "${clip.token}", a capped size that clips`;
  return null;
}

/** The first thing that hides `target` at some width: on it, on any element around it, or on any inside it. */
export function hidingOf(target: HTMLElement): string | null {
  const name = (el: Element) => `<${el.tagName.toLowerCase()}${(el as HTMLElement).dataset.testid ? ` data-testid="${(el as HTMLElement).dataset.testid}"` : ""}>`;
  for (let el: HTMLElement | null = target.parentElement; el; el = el.parentElement) {
    const why = hiddenBy(el, false);
    if (why) return `${name(el)} around it: ${why}`;
  }
  for (const el of [target, ...target.querySelectorAll("*")]) {
    const why = hiddenBy(el, true);
    if (why) return `${name(el)}: ${why}`;
  }
  return null;
}

// ── the strip's own words ───────────────────────────────────────────────────────────────────────

export const STEP_WORDS = REQUIREMENT_LIFECYCLE.map((s) => REQUIREMENT_STATE_LABELS[s]);
/** Any lifecycle step's name, as a word, in any case: the only place it may stand is the step bar. */
const A_STEP = new RegExp(`(^|[^\\p{L}])(${STEP_WORDS.join("|")})($|[^\\p{L}])`, "iu");
/** The attributes a word can hide in where a sighted reader still meets it: a tooltip, an accessible name. */
const LABELS = ["aria-label", "aria-description", "aria-roledescription", "title", "alt", "placeholder", "aria-valuetext"];
const VERDICT_WORDS = new Set<string>(Object.values(BC_VERDICT_LABELS));
const VERDICT_HINTS = new Set<string>(BC_VERDICTS.map((v) => statusReading("bcVerdict", v, "en").hint ?? ""));
const GLYPHS = new Set(BC_VERDICTS.map((v) => statusReading("bcVerdict", v, "en").glyph ?? ""));

/** What the banner may say, whole: one of its heads, then core's act or what an ended one says. */
function bannerSentences(s: RequirementDetail["standing"]): Set<string> {
  const w = saidView(s.waitingOn, "en");
  const heads = ["requirements.banner.accepted", "requirements.banner.dropped", "requirements.banner.stuck", "requirements.banner.waitingOnYou"].map((k) => t(k as Parameters<typeof t>[0]));
  heads.push(t("requirements.banner.waitingOn", { who: w.who }));
  const bodies = [w.act, t("requirements.banner.nothingOwed"), t("requirements.banner.noOwner")];
  return new Set(heads.flatMap((h) => bodies.map((b) => `${h} ${b}`.trim())));
}

/** The first thing the banner says that core's wait did not, or null: its sentence, its effect, its rule and its one link. */
function bannerStray(banner: Element, s: RequirementDetail["standing"]): string | null {
  const w = saidView(s.waitingOn, "en");
  const effect = banner.querySelector('[data-testid="wait-effect"]');
  if (effect && effect.textContent !== w.effect) return `the banner's effect "${effect.textContent}"`;
  const body = banner.cloneNode(true) as Element;
  body.querySelector('[data-testid="wait-effect"]')?.remove();
  const text = (body.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!bannerSentences(s).has(text)) return `the text "${text}" in the banner`;
  for (const el of [banner, ...banner.querySelectorAll("*")]) {
    for (const attr of LABELS) {
      const v = el.getAttribute(attr);
      if (v !== null && v !== w.rule) return `the banner's ${attr} "${v}"`;
    }
  }
  for (const a of banner.querySelectorAll("a")) {
    if (!a.matches('[data-testid="wait-ref"]') || a.textContent !== s.waitingOn.ref || a.getAttribute("data-refers") !== s.waitingOn.refers) return `a link of the banner's own: "${a.textContent}"`;
  }
  return null;
}

/** The line under the step bar the lifecycle alone decides: "Step 2 of 5 · next In delivery". */
function captionOf(state: RequirementState): string | null {
  const at = REQUIREMENT_LIFECYCLE.indexOf(state as (typeof REQUIREMENT_LIFECYCLE)[number]);
  if (at < 0) return null;
  const caption = t("requirements.step.caption", { at: at + 1, of: REQUIREMENT_LIFECYCLE.length });
  const next = REQUIREMENT_LIFECYCLE[at + 1];
  return next ? t("requirements.step.next", { caption, state: REQUIREMENT_STATE_LABELS[next] }) : caption;
}

/** The first thing in the one step bar that is not the lifecycle, in order, and its caption, or null. */
function barStray(bar: Element, s: RequirementDetail["standing"]): string | null {
  const lists = bar.querySelectorAll("ol, ul, [role='list']");
  if (lists.length !== 1) return `a step bar holding ${lists.length} lists`;
  const words = [...(lists[0] as Element).children].map((li) => li.querySelector("span:not([aria-hidden])")?.textContent ?? "");
  if (words.join("|") !== STEP_WORDS.join("|")) return `a step list that is not the lifecycle: "${words.join(", ")}"`;
  const allowed = new Set([...STEP_WORDS, captionOf(s.state) ?? ""]);
  const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    if (text && !allowed.has(text)) return `the text "${text}" in the step bar`;
  }
  return null;
}

/**
 * The first thing in `strip` that is not the lifecycle's or a verdict's own, or null. A lifecycle step's
 * name stands only in the one step bar, which is the lifecycle in order, however anything else is
 * marked up: as a list, plain spans, one sentence or a tooltip. The banner says core's wait and
 * nothing else; every other word is a verdict's, its glyph, a number or k/n verified.
 */
export function strayInStrip(strip: HTMLElement, s: RequirementDetail["standing"]): string | null {
  const bars = strip.querySelectorAll('[data-testid="step-bar"]');
  if (bars.length > 1) return `a second step list (${bars.length} step bars)`;
  const bar = bars[0] ?? null;
  const barWhy = bar ? barStray(bar, s) : null;
  if (barWhy) return barWhy;
  const banners = strip.querySelectorAll('[data-testid="wait-banner"]');
  if (banners.length !== 1) return `${banners.length} banners`;
  const bannerWhy = bannerStray(banners[0] as Element, s);
  if (bannerWhy) return bannerWhy;
  const own = (el: Element | null) => !!el?.closest('[data-testid="step-bar"], [data-testid="wait-banner"]');
  for (const list of strip.querySelectorAll("ol, ul, [role='list']")) {
    if (own(list)) continue;
    if (list.matches('[data-testid="progress-verdicts"]')) {
      for (const li of list.children) {
        const word = li.querySelector('[data-testid="verdict-word"]')?.textContent ?? "";
        if (!VERDICT_WORDS.has(word) || !BC_VERDICTS.includes(li.getAttribute("data-verdict") as BcVerdict)) return `a verdict count that is not a verdict's own: "${li.textContent}"`;
      }
      continue;
    }
    return `a list of its own: "${[...list.children].map((li) => (li.textContent ?? "").trim()).join(", ")}"`;
  }
  const { passing: k, criteria: n } = criteriaCoverageOf(s.coverage);
  const words = new Set<string>([...VERDICT_WORDS, ...GLYPHS, t("requirements.verified", { a: k, b: n })]);
  const walker = document.createTreeWalker(strip, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (own(node.parentElement)) continue;
    const text = (node.textContent ?? "").trim();
    if (!text || /^\d+$/.test(text)) continue;
    if (A_STEP.test(text)) return `a lifecycle step outside the step bar: "${text}"`;
    if (!words.has(text)) return `the text "${text}"`;
  }
  for (const el of [strip, ...strip.querySelectorAll("*")]) {
    if (own(el)) continue;
    for (const attr of LABELS) {
      const v = el.getAttribute(attr);
      if (v === null) continue;
      if (A_STEP.test(v)) return `a lifecycle step outside the step bar, in its ${attr} "${v}"`;
      if (attr !== "aria-label" && !VERDICT_HINTS.has(v)) return `the ${attr} "${v}"`;
    }
  }
  return null;
}

// ── one waiting-on and one verified count on the page ────────────────────────────────────────────

/** The design system's pieces that say whom something waits on, a step or a verified count. */
const PROGRESS_PARTS = ["waiting-on", "wait-banner", "step-bar", "progress-verified", "progress-verdicts", "facts-coverage", "facts-forecast", "verdict-dot"];
const VERIFIED_COUNTS = [
  /\d+\s*\/\s*\d+\s*(verified|passing|passed|proven|criteria)/i,
  /\d+\s+of\s+\d+\s+(criteria|verified|proven|passing|passed)/i,
  /(passing|passed|verified|proven)\s*:?\s*\d+\s*(\/|of)\s*\d+/i,
  /criteria proven/i,
];
const WAITING_WORDS = /waiting on|waits on|paused|owed next|whose turn/i;

/**
 * The first second waiting-on or second verified count anywhere on `root` outside the strip, or null:
 * a design-system piece that says either, or the words, whatever marks them up. The criteria
 * checklist's own "k/n verified" heading is the one count the page carries twice (REQ-35 BC-6), and
 * a verdict dot stands only beside a criterion in it.
 */
export function secondProgress(root: HTMLElement, s: RequirementDetail["standing"]): string | null {
  const strips = root.querySelectorAll('[data-testid="requirement-progress"]');
  if (strips.length !== 1) return `${strips.length} strips`;
  const outside = root.cloneNode(true) as HTMLElement;
  outside.querySelector('[data-testid="requirement-progress"]')?.remove();
  outside.querySelectorAll('[data-testid="criteria-verified"]').forEach((el) => {
    el.remove();
  });
  outside.querySelectorAll('[data-testid="criterion-row"] [data-testid="verdict-dot"]').forEach((el) => {
    el.remove();
  });
  for (const id of PROGRESS_PARTS) {
    const el = outside.querySelector(`[data-testid="${id}"]`);
    if (el) return `a second ${id}: "${el.textContent}"`;
  }
  const text = outside.textContent ?? "";
  for (const re of VERIFIED_COUNTS) {
    const m = text.match(re);
    if (m) return `a second verified count: "${m[0]}"`;
  }
  const words = text.match(WAITING_WORDS);
  if (words) return `a second waiting-on: "${words[0]}"`;
  const w = saidView(s.waitingOn, "en");
  for (const said of [`${w.who} · ${w.act}`, `${w.who}: ${w.act}`, w.act]) {
    if (said.length > 3 && text.includes(said)) return `a second waiting-on: "${said}"`;
  }
  return null;
}

/** The first thing the rail says that the strip already says, or null. */
export function railRepeats(rail: HTMLElement): string | null {
  for (const id of ["step-bar", "wait-banner", "waiting-on", "facts-coverage", "progress-verified", "verdict-dot", "facts-forecast"]) {
    if (within(rail).queryByTestId(id)) return `a ${id}`;
  }
  const state = rail.querySelector('[data-testid="status-badge"][data-family="requirement"]');
  if (state) return `the requirement's state badge "${state.textContent}"`;
  const text = rail.textContent ?? "";
  const caption = new RegExp(t("requirements.step.caption", { at: "\\d+", of: "\\d+" }));
  for (const [what, re] of [["a step caption", caption], ...VERIFIED_COUNTS.map((r) => ["a verified count", r] as const), ["a waiting-on", WAITING_WORDS]] as const) {
    const m = text.match(re);
    if (m) return `${what}: "${m[0]}"`;
  }
  return null;
}

/** The peek beside the list, open on the fixture. */
export function peek(d: RequirementDetail = reqDetail) {
  renderWithQuery(<RequirementPeek projectId={PROJECT} slug="hop" reqKey="REQ-1" peek={{ open: "REQ-1", position: { at: 1, of: 1 }, set: () => {}, move: () => {} }} onOpenFull={() => {}} />, client(d));
}
