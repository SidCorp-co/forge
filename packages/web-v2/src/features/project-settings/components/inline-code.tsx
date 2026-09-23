/** A release blocker is authored once for API callers and this screen alike, so
 *  its code spans are markdown; plain text put the backticks on screen (ISS-1127). */

import type { ReactNode } from "react";

export function inlineCode(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	const parts = text.split("`");
	for (const [i, part] of parts.entries()) {
		if (part === "") continue;
		const paired = i % 2 === 1 && i < parts.length - 1;
		out.push(
			paired ? (
				<code key={`c${i}`} className="rounded bg-subtle px-1 font-mono text-[0.92em]">
					{part}
				</code>
			) : (
				<span key={`t${i}`}>{i % 2 === 1 ? `\`${part}` : part}</span>
			),
		);
	}
	return out;
}
