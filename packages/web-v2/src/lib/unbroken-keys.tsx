/** An issue key (a project's prefix, a hyphen and its number: `ISS-5`, `HOP-12`) is one token a
 *  person reads, searches and types, and a browser breaks it at its hyphen otherwise: judge-169 read
 *  "ISS-" / "5" in the Batch release dialog at 390 (ISS-1421 r42). The prefix's shape is core's
 *  (`lib/issue-ref.ts` PREFIX_SHAPE). */

import type { ReactNode } from "react";

export const ISSUE_KEY_IN_TEXT = /(?<![A-Za-z0-9-])[A-Z][A-Z0-9]{1,5}-\d{1,10}(?![A-Za-z0-9])/g;

/** The class that holds a key on one line; the Markdown step gives the same span. */
export const UNBROKEN_KEY_CLASS = "whitespace-nowrap";

/** `text` with each issue key in a span that does not wrap; the rest stays plain text. */
export function unbrokenKeys(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let from = 0;
	for (const match of text.matchAll(ISSUE_KEY_IN_TEXT)) {
		const at = match.index ?? 0;
		if (at > from) out.push(text.slice(from, at));
		out.push(
			<span key={`k${at}`} className={UNBROKEN_KEY_CLASS}>
				{match[0]}
			</span>,
		);
		from = at + match[0].length;
	}
	if (from < text.length) out.push(text.slice(from));
	return out;
}

interface TextNode {
	type: "text";
	value: string;
}

interface ParentNode {
	type: string;
	children?: Array<ParentNode | TextNode>;
}

/** The same rule as a remark step, for every Markdown body (comments, descriptions, plans): each key
 *  in a text node becomes a span the page renders with `UNBROKEN_KEY_CLASS`. Code is left as it is. */
export function remarkUnbrokenKeys() {
	const visit = (node: ParentNode) => {
		if (!node.children || node.type === "code" || node.type === "inlineCode") return;
		node.children = node.children.flatMap((child) => {
			if (child.type !== "text") {
				visit(child as ParentNode);
				return [child];
			}
			const value = (child as TextNode).value;
			const parts: Array<ParentNode | TextNode> = [];
			let from = 0;
			for (const match of value.matchAll(ISSUE_KEY_IN_TEXT)) {
				const at = match.index ?? 0;
				if (at > from) parts.push({ type: "text", value: value.slice(from, at) });
				parts.push({
					type: "unbrokenKey",
					data: { hName: "span", hProperties: { className: [UNBROKEN_KEY_CLASS] } },
					children: [{ type: "text", value: match[0] }],
				} as ParentNode);
				from = at + match[0].length;
			}
			if (parts.length === 0) return [child];
			if (from < value.length) parts.push({ type: "text", value: value.slice(from) });
			return parts;
		});
	};
	return (tree: ParentNode) => visit(tree);
}
