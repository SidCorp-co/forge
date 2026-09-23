/** A release blocker's code spans are markdown, authored once for API callers and this screen.
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
				<code key={`c${i}`} className="fg-code">
					{part}
				</code>
			) : (
				<span key={`t${i}`}>{i % 2 === 1 ? `\`${part}` : part}</span>
			),
		);
	}
	return out;
}
