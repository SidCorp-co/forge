// What the person picks on the MCP consent page, and the decision it becomes. The page picks no
// reach on the person's behalf: which projects and which permissions both start unchosen, as on the
// token form (ISS-1255), and allowing is refused until each is chosen.
import type { McpConsentDecision, McpConsentView, McpOAuthScope } from "@forge/contracts/mcp-auth";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

export interface ConsentDraft {
  /** "" until chosen; "all" reaches every project the person can see. */
  reach: "" | "all" | "chosen";
  projectIds: string[];
  grantMode: "" | "full" | "named";
  permissions: string[];
  scopes: McpOAuthScope[];
}

export type ConsentErrors = {
  reach?: ProductCopyKey;
  permissions?: ProductCopyKey;
  scopes?: ProductCopyKey;
};

/** The OAuth request's own parameters, as the client sent them to the page. */
export const REQUEST_KEYS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
  "state",
] as const;

export type ConsentRequest = Partial<Record<(typeof REQUEST_KEYS)[number], string>>;

/** The request's parameters out of the page's query, every other key left behind. */
export function requestFrom(params: URLSearchParams): ConsentRequest {
  const out: ConsentRequest = {};
  for (const key of REQUEST_KEYS) {
    const value = params.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

export function draftFor(view: McpConsentView): ConsentDraft {
  return { reach: "", projectIds: [], grantMode: "", permissions: [], scopes: [...view.requestedScopes] };
}

/** The permissions a pick may hold: an account permission reaches no project, so a fenced grant offers none. */
export function offeredPermissions(view: McpConsentView, reach: ConsentDraft["reach"]): string[] {
  const names = [...view.menu.permissions, ...view.menu.explicit];
  return reach === "chosen" ? names.filter((p) => !view.menu.accountOnly.includes(p)) : names;
}

export function toggled<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** What is wrong with the draft, or the allow decision it makes with the request. */
export function allowDecision(
  draft: ConsentDraft,
  view: McpConsentView,
  request: ConsentRequest,
): { errors: ConsentErrors; decision: Record<string, unknown> | null } {
  const errors: ConsentErrors = {};
  if (!draft.reach) errors.reach = "auth.mcpConsent.err.reach";
  else if (draft.reach === "chosen" && draft.projectIds.length === 0) errors.reach = "auth.mcpConsent.err.projects";
  if (!draft.grantMode) errors.permissions = "auth.mcpConsent.err.grant";
  const offered = offeredPermissions(view, draft.reach);
  const picked = draft.permissions.filter((p) => offered.includes(p));
  if (draft.grantMode === "named" && picked.length === 0) errors.permissions = "auth.mcpConsent.err.permissions";
  if (draft.scopes.length === 0) errors.scopes = "auth.mcpConsent.err.scopes";
  if (Object.keys(errors).length > 0) return { errors, decision: null };
  return {
    errors,
    decision: {
      ...request,
      decision: "allow" satisfies McpConsentDecision["decision"],
      project_ids: draft.reach === "chosen" ? draft.projectIds : null,
      permissions: draft.grantMode === "full" ? [view.menu.full] : picked,
      scopes: draft.scopes,
    },
  };
}

export function denyDecision(request: ConsentRequest): Record<string, unknown> {
  return { ...request, decision: "deny" satisfies McpConsentDecision["decision"] };
}
