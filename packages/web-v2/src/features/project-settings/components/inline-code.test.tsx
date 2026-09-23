// @vitest-environment jsdom
//
// A release blocker is only a remedy if the operator can read it. The `<code>`
// spans this renderer emits shipped with `bg-subtle`, and `--color-subtle` is
// `--fg-subtle` — a foreground token — so every span filled with ink-500 grey and
// kept the banner's own tone as its text: 1.21:1 in attention and 1.46:1 in danger
// against AA's 4.5:1 (ISS-1127). Tailwind generates a `bg-*` utility for every
// `--color-*` name, so nothing refuses that class; the measurement below does.
//
// The colours are resolved from the stylesheets rather than restated here, and the
// tones from `banner.tsx`'s own map, so a token moved or a tone added is measured
// and not assumed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { inlineCode } from "./inline-code";

const SRC = join(__dirname, "..", "..", "..");
const TOKENS = readFileSync(join(SRC, "styles", "tokens.css"), "utf8");
const GLOBALS = readFileSync(join(SRC, "app", "globals.css"), "utf8");
const BANNER = readFileSync(join(SRC, "design", "primitives", "banner.tsx"), "utf8");

const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `--name: value` a stylesheet declares, comments dropped. */
function declarations(css: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of uncommented(css).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/g)) {
		if (!out.has(m[1])) out.set(m[1], m[2].trim());
	}
	return out;
}

const VARS = new Map([...declarations(TOKENS), ...declarations(GLOBALS)]);

/** Follow a `var(--x)` chain to the literal it ends at. */
function literal(value: string): string {
	let seen = value.trim();
	for (let hop = 0; hop < 12; hop += 1) {
		const m = /^var\((--[a-z0-9-]+)\)$/.exec(seen);
		if (!m) return seen;
		const next = VARS.get(m[1]);
		if (next === undefined) throw new Error(`no declaration for ${m[1]}`);
		seen = next.trim();
	}
	throw new Error(`var() chain did not terminate at ${value}`);
}

/** The `color` and `background` a named class rule in tokens.css sets. */
function classRule(name: string): { color?: string; background?: string } {
	const m = new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(uncommented(TOKENS));
	if (!m) return {};
	const body = m[1];
	const pick = (prop: string) => {
		const d = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
		return d ? d[1].trim() : undefined;
	};
	return { color: pick("color"), background: pick("background") };
}

/** What a class list on an element paints, before anything it inherits. */
function painted(classList: string): { color?: string; background?: string } {
	const out: { color?: string; background?: string } = {};
	for (const token of classList.split(/\s+/).filter(Boolean)) {
		const rule = classRule(token);
		if (rule.color) out.color = literal(rule.color);
		if (rule.background) out.background = literal(rule.background);
		const bg = /^bg-([a-z0-9-]+)$/.exec(token);
		if (bg && VARS.has(`--color-${bg[1]}`)) out.background = literal(`var(--color-${bg[1]})`);
		const fg = /^text-([a-z0-9-]+)$/.exec(token);
		if (fg && VARS.has(`--color-${fg[1]}`)) out.color = literal(`var(--color-${fg[1]})`);
	}
	return out;
}

function channel(byte: number): number {
	const c = byte / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) throw new Error(`not a six-digit hex colour: ${hex}`);
	const [r, g, b] = [0, 2, 4].map((at) => channel(Number.parseInt(m[1].slice(at, at + 2), 16)));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** `banner.tsx`'s own tone map, so a tone added later is measured too. */
function bannerTones(): { tone: string; fg: string; bg: string }[] {
	const tones = [...BANNER.matchAll(/(\w+):\s*\{\s*fg:\s*"([^"]+)",\s*bg:\s*"([^"]+)"/g)].map(
		(m) => ({ tone: m[1], fg: literal(m[2]), bg: literal(m[3]) }),
	);
	if (tones.length === 0) throw new Error("banner.tsx declared no tones this test could read");
	return tones;
}

/** The class the renderer actually puts on a paired span. */
function codeClass(): string {
	const view = render(<div>{inlineCode("send `releaseRunnerLabel` as null")}</div>);
	const el = view.container.querySelector("code");
	if (!el) throw new Error("the renderer emitted no <code> element");
	const cls = el.className;
	view.unmount();
	return cls;
}

const AA = 4.5;

describe("a code span inside a release banner is readable", () => {
	it("meets AA against its own background in every tone the banner carries", () => {
		const span = painted(codeClass());
		for (const { tone, fg, bg } of bannerTones()) {
			const color = span.color ?? fg;
			const background = span.background ?? bg;
			expect(
				contrast(color, background),
				`${tone}: ${color} on ${background}`,
			).toBeGreaterThanOrEqual(AA);
		}
	});

	it("takes the design system's code-span style rather than a utility", () => {
		const cls = codeClass();
		expect(cls.split(/\s+/)).toContain("fg-code");
		expect(classRule("fg-code").background).toBeTruthy();
		expect(classRule("fg-code").color).toBeTruthy();
	});

	it("names no background utility built from a foreground token", () => {
		for (const token of codeClass().split(/\s+/).filter(Boolean)) {
			const bg = /^bg-([a-z0-9-]+)$/.exec(token);
			if (!bg) continue;
			expect(VARS.get(`--color-${bg[1]}`), `${token} paints with --color-${bg[1]}`).not.toMatch(
				/var\(--fg-/,
			);
		}
	});
});

describe("the measurement can fail", () => {
	// The shipped class list, run through the same resolver. A green above is worth
	// nothing unless these three go red, and they are the numbers the judging run
	// measured on the deployed screen.
	const SHIPPED = "rounded bg-subtle px-1 font-mono text-[0.92em]";

	it("reads --color-subtle as the foreground token it is", () => {
		expect(VARS.get("--color-subtle")).toBe("var(--fg-subtle)");
		expect(painted(SHIPPED).background).toBe(literal("var(--ink-500)"));
		expect(painted(SHIPPED).color).toBeUndefined();
	});

	it("scores the shipped span below AA in every tone", () => {
		const span = painted(SHIPPED);
		for (const { tone, fg, bg } of bannerTones()) {
			const ratio = contrast(span.color ?? fg, span.background ?? bg);
			expect(ratio, `${tone}`).toBeLessThan(AA);
		}
	});

	it("reproduces the two ratios the judging run measured", () => {
		const span = painted(SHIPPED);
		const tones = new Map(bannerTones().map((t) => [t.tone, t]));
		const at = (tone: string) => {
			const t = tones.get(tone);
			if (!t) throw new Error(`banner.tsx no longer carries a ${tone} tone`);
			return Number(contrast(span.color ?? t.fg, span.background ?? t.bg).toFixed(2));
		};
		expect(at("attention")).toBe(1.21);
		expect(at("danger")).toBe(1.46);
	});

	it("computes a ratio it can be checked against by hand", () => {
		expect(Number(contrast("#000000", "#FFFFFF").toFixed(2))).toBe(21);
		expect(Number(contrast("#767D8A", "#767D8A").toFixed(2))).toBe(1);
	});
});
