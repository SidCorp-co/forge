/** The least a diagram is scaled by: mermaid draws its labels at 16px, and this keeps them at 12px. */
export const MIN_DIAGRAM_SCALE = 0.75;

/**
 * The narrowest a diagram may be drawn, from the `viewBox` mermaid gives its svg, or null where that
 * carries no width. Narrower than its column it still fits; wider, it is held here and scrolls.
 */
export function diagramMinWidth(viewBox: string | null): number | null {
	const width = Number((viewBox ?? "").trim().split(/[\s,]+/)[2]);
	if (!Number.isFinite(width) || width <= 0) return null;
	return Math.ceil(width * MIN_DIAGRAM_SCALE);
}
