import { isPlainObject } from "@forge/contracts/document-patch";
import { pointerOf } from "@/features/project-config/document-edit";

export const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const SECRET_REF = /^secret:\/\/([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/;

interface SecretUse {
	ref: string;
	scope: string;
	name: string;
	profileId: string;
	path: string;
}

export function secretUsesIn(profileId: string, document: unknown): SecretUse[] {
	const out: SecretUse[] = [];
	const walk = (value: unknown, path: string[]) => {
		if (typeof value === "string") {
			const m = SECRET_REF.exec(value);
			if (m?.[1] && m[2]) out.push({ ref: value, scope: m[1], name: m[2], profileId, path: pointerOf(path) });
			return;
		}
		const entries = Array.isArray(value)
			? value.map((v, i) => [String(i), v] as const)
			: isPlainObject(value)
				? Object.entries(value)
				: [];
		for (const [k, v] of entries) walk(v, [...path, k]);
	};
	walk(document, []);
	return out;
}

export type SecretStanding = "stored" | "missing" | "unread";

export function standingOf(ref: string, stored: ReadonlySet<string> | null): SecretStanding {
	if (stored === null) return "unread";
	return stored.has(ref) ? "stored" : "missing";
}
