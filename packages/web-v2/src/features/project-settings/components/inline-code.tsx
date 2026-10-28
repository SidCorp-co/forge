/** A release blocker's code spans are markdown, authored once for API callers and every screen showing one.
 *  `fg-code` is the design system's span; `bg-subtle` named a FOREGROUND token (ISS-1127). */

import type { ReactNode } from "react";
import { unbrokenKeys } from "@/lib/unbroken-keys";

/** A key, a field or a value breaks at its hyphen or dot otherwise; a URL or a phrase still wraps. */
const oneLine = (part: string) => part.length <= 32 && !/\s/.test(part);

export function inlineCode(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	const parts = text.split("`");
	for (const [i, part] of parts.entries()) {
		if (part === "") continue;
		const paired = i % 2 === 1 && i < parts.length - 1;
		out.push(
			paired ? (
				<code key={`c${i}`} className={oneLine(part) ? "fg-code whitespace-nowrap" : "fg-code"}>
					{part}
				</code>
			) : (
				<span key={`t${i}`}>{unbrokenKeys(i % 2 === 1 ? `\`${part}` : part)}</span>
			),
		);
	}
	return out;
}
