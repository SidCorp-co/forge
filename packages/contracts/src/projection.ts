// an agent's context is the budget a tool answer spends: a list or a write answers a
// summary by default, and a whole document is read only when asked for (ISS-87)

export const ANSWER_VIEWS = ["summary", "full"] as const;

export function pickFields<T extends object, K extends keyof T>(
	row: T,
	fields: readonly K[],
): Pick<T, K> {
	const picked = {} as Pick<T, K>;
	for (const field of fields) picked[field] = row[field];
	return picked;
}
