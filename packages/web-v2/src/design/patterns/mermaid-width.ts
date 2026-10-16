export const MIN_DIAGRAM_SCALE = 0.75;

export function diagramMinWidth(viewBox: string | null): number | null {
	const width = Number((viewBox ?? "").trim().split(/[\s,]+/)[2]);
	if (!Number.isFinite(width) || width <= 0) return null;
	return Math.ceil(width * MIN_DIAGRAM_SCALE);
}
