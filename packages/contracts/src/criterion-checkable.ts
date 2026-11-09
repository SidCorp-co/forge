// Whether a criterion can be checked on the running product (REQ-67 BC-1), read off its `form`: a
// statement says what holds, which a judge finds true or false there; a scenario reads as
// Given … When … Then. An instruction ("Verify the cards are saved") states nothing that holds, so no
// verdict on the running product can pass or fail it. The requirement-ready checklist asks it before
// an agree (its `checkable` question), and the steward writes an issue's criteria by the same rule.

/** A statement that opens as an instruction to check something rather than saying what holds. */
export const CRITERION_INSTRUCTION =
	/^(?:verify|check|ensure|confirm|test|make sure|validate)\b(?!-)/i;

/** Whether `body` reads as Given … When … Then, each keyword opening a line, in that order. */
export function scenarioParses(body: string): boolean {
	const starts = body
		.split("\n")
		.map((l) => l.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
	const g = starts.indexOf("given");
	const w = starts.indexOf("when");
	const t = starts.indexOf("then");
	return g !== -1 && w > g && t > w;
}

/** Why a criterion of `form` reading `body` cannot be checked on the running product, or null. */
export function uncheckableWhy(criterion: {
	form: string;
	body: string;
}): string | null {
	const body = criterion.body.trim();
	if (criterion.form === "scenario") {
		return scenarioParses(body)
			? null
			: "its scenario does not read Given, When, Then";
	}
	return CRITERION_INSTRUCTION.test(body)
		? "it says what to check, not what holds"
		: null;
}
