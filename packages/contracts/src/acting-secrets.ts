// A project secret declared for acting (REQ-88): a credential the project's master, or a declared run
// working one of its issues, acts with (publishing docs with a store's key, say), read at one door
// and recorded on every read. Apart from a testing profile's secrets, which judge landed work and
// keep their own door and rule.

import type { RefusalStatuses } from "./refusal.js";

/** Who a declaration may name: the project's resident master, and declared runs working its issues. */
export const ACTING_SECRET_READERS = ["master", "runs"] as const;
export type ActingSecretReader = (typeof ACTING_SECRET_READERS)[number];

export const ACTING_SECRET_REFUSAL_CODES = [
	/** The answer's own code where a read is refused for several reasons at once. */
	"ACTING_SECRET_REFUSED",
	/** The project document declares no acting secret of that ref. */
	"ACTING_SECRET_NOT_DECLARED",
	/** The caller is a reader the declaration does not name, or no reader at all (a person). */
	"ACTING_SECRET_READER_NOT_NAMED",
	/** A call naming no run, from a box holding no live master of the project. */
	"ACTING_SECRET_NOT_THE_MASTER",
	/** The run named has ended. */
	"ACTING_SECRET_RUN_ENDED",
	/** The run named is declared and not admitted yet. */
	"ACTING_SECRET_RUN_NOT_ADMITTED",
	/** The run named works another project's issues, or a project this box no longer serves. */
	"ACTING_SECRET_RUN_OTHER_PROJECT",
	/** Core holds no run this box declared under the id named. */
	"ACTING_SECRET_RUN_NOT_RECORDED",
	/** The run named was declared over no issue of the project. */
	"ACTING_SECRET_RUN_NO_ISSUE",
	/** A testing profile names the secret: it is read at the testing door, under its rule. */
	"ACTING_SECRET_TESTING_PROFILE_NAMES",
	/** The project stores no value under the declared ref. */
	"ACTING_SECRET_VALUE_MISSING",
	/** The stored value does not decrypt under this core's key. */
	"ACTING_SECRET_VALUE_UNREADABLE",
	/** The stored value is shorter than the log scrubber replaces. */
	"ACTING_SECRET_TOO_SHORT_TO_SCRUB",
	/** The vault key is not set, so nothing can be decrypted. */
	"ACTING_SECRET_VAULT_NOT_CONFIGURED",
	/** A value guessed at a path that serves none: it is read at the acting door. */
	"ACTING_SECRET_READ_ELSEWHERE",
	/** The path is not a project id, a scope and a name, or the query not one run id. */
	"ACTING_SECRET_READ_SHAPE",
] as const;
export type ActingSecretRefusalCode =
	(typeof ACTING_SECRET_REFUSAL_CODES)[number];

export const ACTING_SECRET_REFUSAL_STATUSES = {
	ACTING_SECRET_NOT_DECLARED: 404,
	ACTING_SECRET_READER_NOT_NAMED: 403,
	ACTING_SECRET_NOT_THE_MASTER: 403,
	ACTING_SECRET_RUN_ENDED: 403,
	ACTING_SECRET_RUN_NOT_ADMITTED: 403,
	ACTING_SECRET_RUN_OTHER_PROJECT: 403,
	ACTING_SECRET_RUN_NOT_RECORDED: 409,
	ACTING_SECRET_VALUE_MISSING: 404,
	ACTING_SECRET_VAULT_NOT_CONFIGURED: 503,
	ACTING_SECRET_READ_ELSEWHERE: 404,
	ACTING_SECRET_READ_SHAPE: 400,
} as const satisfies RefusalStatuses<ActingSecretRefusalCode>;

/** Who read: the master by its session, or a declared run by core's run and session ids. */
export type ActingSecretReaderView =
	| { kind: "master"; session: string }
	| { kind: "run"; id: string; session: string; issues: string[] };

/** `GET /api/projects/:id/acting-secrets/:scope/:name`: the one place the value leaves core. */
export interface ActingSecretReadView {
	secret: string;
	value: string;
	reader: ActingSecretReaderView;
}

/** One read, as the owner sees it: who, which secret, which run or session, when; never the value. */
export interface ActingSecretReadRecord {
	secret: string;
	reader: ActingSecretReader;
	/** The account the reading credential acts for. */
	actor: string | null;
	box: string;
	session: string;
	/** Core's run id, where a declared run read. */
	run: string | null;
	/** The issues the run was declared over; none for the master. */
	issues: string[];
	at: string;
}

/** `GET /api/projects/:id/acting-secrets`: what is declared, and the reads made of it. */
export interface ActingSecretsView {
	declared: Array<{
		secret: string;
		readers: ActingSecretReader[];
		valueAt: string;
	}>;
	reads: ActingSecretReadRecord[];
	returned: number;
}
