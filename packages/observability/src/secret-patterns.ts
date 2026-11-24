// The secret filter's vocabulary: the key names, prose labels and shapes a secret is read by, which
// the scrubber (secret-scrub.ts) replaces and the detector (secret-spans.ts) names.

/** Header names whose values must be replaced before send. Compared case-insensitively. */
export const SCRUB_HEADER_KEYS: ReadonlySet<string> = new Set([
	"authorization",
	"cookie",
	"x-device-token",
	"x-api-key",
	"x-csrf-token",
	// Coolify, GitLab and GitLab webhook credentials, each sent in a header of its own.
	"x-auth-token",
	"private-token",
	"x-gitlab-token",
]);

const SCRUB_BODY_KEYS: ReadonlySet<string> = new Set([
	"authToken",
	"auth_token",
	"apiKey",
	"api_key",
	"password",
	"secret",
	"jwt",
	"token",
	"accessToken",
	"access_token",
	"refreshToken",
	"refresh_token",
	"sessionToken",
	"session_token",
	"bearerToken",
	// Retired by ISS-12, kept for ever: old clients, logs and replays still send it.
	"testCredentials",
	// ISS-1036 — a GitHub App's PEM and a Google service-account key file. Both
	// are credentials with no token-shaped signature of their own, so the key
	// name is the only thing that identifies them in a structured payload.
	"privateKey",
	"private_key",
	"serviceAccountJson",
	"service_account_json",
	"secretKey",
	"secret_key",
]);

/** Labels a secret is written under in prose, two words where a body key is one (ISS-1326's
 *  builder found `secret key: <hex>` read as text), and the Vietnamese word for a password, with and
 *  without its marks (ISS-1353: a room stored `mật khẩu: <value>` as written). Read in text only,
 *  never as an object key. */
const PROSE_LABELS: readonly string[] = [
	"secret key",
	"secret-key",
	"api key",
	"api-key",
	"mật khẩu", // i18n-allow: the Vietnamese label a password is written under
	"mat khau",
];

/** Matches `?token=...` / `?jwt=...` / `?access_token=...` / `?api_key=...` query params. */
export const URL_TOKEN_PATTERN =
	/([?&](?:token|jwt|access_token|refresh_token|api_key)=)[^&#]+/gi;

/**
 * ISS-150 — PAT plaintext shape (`forge_pat_<env>_<hex>`). Unanchored and
 * global so we can redact tokens that leak inside larger strings — query
 * params, JSON bodies, breadcrumb messages.
 */
export const PAT_STRING_PATTERN = /forge_pat_(?:dev|stg|prd)_[A-Fa-f0-9]+/g;

/**
 * A share link's token (`@forge/contracts/shares:SHARE_TOKEN_PREFIX`): whoever holds it opens the
 * share, so it is redacted wherever it turns up, a `/s/<token>` path included. A cut-off or altered
 * one goes too.
 */
export const SHARE_TOKEN_STRING_PATTERN = /forge_share_[A-Za-z0-9_-]{8,}/g;

/**
 * An MCP client's refresh token or authorization code (`@forge/contracts/mcp-auth`): a refresh token
 * mints access tokens for a month, so it is redacted wherever it turns up, cut off or not.
 */
export const MCP_OAUTH_SECRET_PATTERN = /forge_mcp_(?:rt|code)_[A-Za-z0-9_-]{8,}/g;

/**
 * A feedback widget visitor's session token or status link token (`@forge/contracts/widget`): the
 * one carries a visitor's chat, the other what they filed, so both are redacted wherever they turn
 * up, a `/api/widget/status/<token>` path included, cut off or not. A site key is public and stays.
 */
export const WIDGET_TOKEN_PATTERN = /fw_(?:sess|stat)_[A-Za-z0-9_-]{8,}/g;

/**
 * A product server's feedback key (`@forge/contracts/feedback-server-keys`): it files feedback into
 * a project as that product, so it is redacted wherever it turns up, cut off or not.
 */
export const FEEDBACK_SERVER_KEY_PATTERN = /\bfsk_[A-Za-z0-9_-]{8,}/g;

export const PEM_PRIVATE_KEY_PATTERN =
	/-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----/g;

export const PEM_PRIVATE_KEY_HEAD_PATTERN =
	/-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----(?:\\n|\s)*(?:[A-Za-z0-9+/=]{16,}(?:(?:\\n|\s)+[A-Za-z0-9+/=]{16,})*)?/g;

/**
 * ISS-1036 — a Google OAuth2 access token, the thing Forge mints from a
 * service-account key. Redacted for the same reason the key is: a token that
 * reaches a log is a live credential for its hour.
 */
export const GOOGLE_ACCESS_TOKEN_PATTERN = /ya29\.[A-Za-z0-9_\-.]+/g;

/** A JWT, or the head of one cut off after its first dot: core mints session JWTs. */
export const JWT_PATTERN =
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?/g;

/**
 * A model-provider key's body after `sk-`: a named family (Anthropic, an OpenAI project, service
 * account or admin key) or a plain run of letters and digits, each at least `min` long.
 */
const skKeyBody = (named: number, plain: number) =>
	`sk-(?:(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{${named},}|[A-Za-z0-9]{${plain},}[A-Za-z0-9_-]*)`;

/**
 * Webhook signing secrets, GitHub tokens and model-provider keys, each by its own prefix.
 *
 * ISS-614: `sk-` is a key where it starts a token, not where it ends a word: `task-<hex>`,
 * `desk-…` and `risk-…` are record ids. Glued to the letters or digits before it, `sk-` is read
 * as a key only at 48 characters or more, the shortest real OpenAI key body, which no 24-hex
 * record id, 32-hex uuid or 40-hex sha reaches.
 */
export const PREFIXED_TOKEN_PATTERN = new RegExp(
	[
		"whsec_[A-Za-z0-9+/=_-]{8,}",
		"gh[pousr]_[A-Za-z0-9]{20,}",
		"github_pat_[A-Za-z0-9_]{20,}",
		`(?<![A-Za-z0-9])${skKeyBody(16, 20)}`,
		skKeyBody(48, 48),
	].join("|"),
	"g",
);

/** The public scheme a provider key opens with, which a refusal may name without the key. */
export const PROVIDER_KEY_LEAD =
	/^(?:whsec_|gh[pousr]_|github_pat_|sk-(?:(?:ant|proj|svcacct|admin)-)?)/;

/**
 * `Bearer <token>`: the scheme stays, the credential goes. A token is told from a word by its shape:
 * a digit, a capital after a small letter, or 24 characters or more. `Bearer credential` is prose.
 */
const BEARER_TOKEN = "[A-Za-z0-9._~+/=-]";
export const BEARER_PATTERN = new RegExp(
	`\\b((?:Bearer|bearer|BEARER)\\s+)(?:(?=${BEARER_TOKEN}*(?:\\d|[a-z][A-Z]))${BEARER_TOKEN}{8,}|${BEARER_TOKEN}{24,})`,
	"g",
);

/** A connection URL's password: `scheme://user:password@host` keeps the scheme, user and host. */
export const URL_PASSWORD_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi;

/** Shapes that say a secret is there though no value follows to redact: a password label, a
 *  private-key header without its closing dashes, a connection URL with an empty password. */
export const SECRET_LABEL_PATTERN =
	/password\s*[:=]|m[ậa]t kh[ẩa]u\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY|postgres(?:ql)?:\/\/\S*:\S*@/gi; // i18n-allow: the Vietnamese password label

export const ENV_SECRET_ASSIGNMENT_PATTERN =
	/^(\s*(?:export\s+)?(?:[A-Z0-9]+_)*(?:PASSWORD|SECRET|TOKEN|KEY|PASS|PEPPER|DSN|CREDENTIALS)(?:_[A-Z0-9]+)*)\s*=\s*\S.*$/;

export const FILTERED = "[Filtered]";

/** Escape a string for safe interpolation into a `RegExp` source, outside a character class. */
export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A credential header's name and separator, and the rest of its line, read ahead rather than taken,
 * so a header named in prose leaves a later one on the same line to be read.
 */
export const HEADER_RE = new RegExp(
	`\\b(${Array.from(SCRUB_HEADER_KEYS).map(escapeRegExp).join("|")})(\\s*[:=]\\s*)(?=(.+))`,
	"gi",
);
// the key may close a JSON string (`"apiKey":`) or an escaped one inside JSON text
// (`\\"apiKey\\":`); the value stops at whitespace, a quote, a backslash, a comma, a brace or `&`,
// so `access_token=...&id=7` keeps its `&id=7`.
export const FIELD_VALUE = /^\s*\\?"?([^\s"\\,}&]+)/;

export const BODY_RES = [...SCRUB_BODY_KEYS, ...PROSE_LABELS].map(
	(k) =>
		new RegExp(
			`(\\b${escapeRegExp(k)}\\b\\\\?"?\\s*[:=]\\s*\\\\?"?)([^\\s"\\\\,}&]+)`,
			"gi",
		),
);

/**
 * ISS-1458 -- a field text ending in a prose label (`... mật khẩu:`, `the api key =`), which is how
 * the scrubber tells a prose label from a body key. Under a prose label a plain word of any
 * language's letters and marks is prose (`mật khẩu: lỗi ở bước gửi email`, FB-856); a body key keeps
 * the ASCII-only word test, so structured scrubbing is untouched.
 *
 * Trade, named: a password of letters alone written after a prose label now passes. That is
 * acceptable because structured keys, tokens, hex, PEM, JWT and URL shapes are scrubbed as before,
 * any value with a digit or symbol (or camelCase, or 24+ characters) after the label is still
 * redacted, and a chat room holds a separate path for a real credential (support.secret_link). It
 * ends when a room is found storing letters-only passwords under a prose label, or when the secret
 * link path stops being the way a person hands one over.
 */
export const PROSE_LABEL_FIELD = new RegExp(
	`(?:${PROSE_LABELS.map(escapeRegExp).join("|")})\\W*$`,
	"i",
);

export const isScrubbedKey = (key: string) =>
	SCRUB_BODY_KEYS.has(key) ||
	SCRUB_BODY_KEYS.has(key.toLowerCase()) ||
	SCRUB_HEADER_KEYS.has(key.toLowerCase());
