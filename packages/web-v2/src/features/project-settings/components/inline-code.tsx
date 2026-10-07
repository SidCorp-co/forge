/** A release blocker's code spans are markdown, authored once for API callers and every screen showing one.
 *  `fg-code` is the design system's span; `bg-subtle` named a FOREGROUND token (ISS-1127). */

import type { ReactNode } from "react";

export function inlineCode(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	const parts = text.split("`");
	for (const [i, part] of parts.entries()) {
		if (part === "") continue;
		const paired = i % 2 === 1 && i < parts.length - 1;
		out.push(
			paired ? (
				<code key={`c${i}`} className="fg-code" translate="no">
					{part}
				</code>
			) : (
				<span key={`t${i}`}>{i % 2 === 1 ? `\`${part}` : part}</span>
			),
		);
	}
	return out;
}

/** Copy with **bold** words and `code` spans, drawn the way the design system draws each. */
export function inlineRich(text: string): ReactNode[] {
	// The pieces are a fixed split of one static sentence: their order never changes between renders.
	// biome-ignore-start lint/suspicious/noArrayIndexKey: positions in a fixed split of static copy
	return text.split("**").flatMap((part, i) =>
		part === "" ? [] : i % 2 === 1 ? [<b key={`b${i}`}>{inlineCode(part)}</b>] : inlineCode(part).map((n, j) => <span key={`p${i}-${j}`}>{n}</span>),
	);
	// biome-ignore-end lint/suspicious/noArrayIndexKey: positions in a fixed split of static copy
}
