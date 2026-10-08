// The fingerprint a declaration's recorded `shapes` hold: FNV-1a over its canonical JSON, as 8 hex
// digits. A machine (`state-machine.ts`) and a checklist (`checklists.ts`) are each versioned by the
// fingerprints of the shapes they have had.

export function fingerprint(canonical: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < canonical.length; i++) {
		hash ^= canonical.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
