import { Field, Input } from "@/design";

// cm:edge contract -> packages/core/src/integrations/autoflow/schemas.ts — the site slug and the token prefix it refuses otherwise.
export const SHOP_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const TOKEN_PREFIX = "sat_";
const REFRESH_PREFIX = "srt_";
const CLIENT_PREFIX = "mcpc_";

/** The refresh pair is optional, but the platform redeems a refresh token only with its client. */
export function refreshPairError(refreshToken: string, clientId: string): string | null {
  const r = refreshToken.trim();
  const c = clientId.trim();
  if (!r && !c) return null;
  if (!r.startsWith(REFRESH_PREFIX)) return "The refresh token is the srt_… issued beside the access token.";
  if (!c.startsWith(CLIENT_PREFIX)) return "The client id is the mcpc_… the token pair was issued to.";
  return null;
}

export interface TokenPair {
  token: string;
  refreshToken: string;
  clientId: string;
}

export const EMPTY_TOKENS: TokenPair = { token: "", refreshToken: "", clientId: "" };

export function tokenSecrets({ token, refreshToken, clientId }: TokenPair): Record<string, string> {
  return {
    accessToken: token.trim(),
    ...(refreshToken.trim() ? { refreshToken: refreshToken.trim(), clientId: clientId.trim() } : {}),
  };
}

export function tokensValid(t: TokenPair): boolean {
  return t.token.trim().startsWith(TOKEN_PREFIX) && refreshPairError(t.refreshToken, t.clientId) === null;
}

export function RefreshPairFields({ value, onChange }: { value: TokenPair; onChange: (next: TokenPair) => void }) {
  const error = refreshPairError(value.refreshToken, value.clientId);
  return (
    <>
      <Field
        label="Refresh token"
        hint="Optional. With it Forge renews the 12-hour access token itself, before it expires; without it the site needs a new token every day."
      >
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="srt_…"
          value={value.refreshToken}
          onChange={(e) => onChange({ ...value, refreshToken: e.target.value })}
        />
      </Field>
      <Field label="Client id" hint="The OAuth client the tokens were issued to; required with a refresh token.">
        <Input
          placeholder="mcpc_…"
          value={value.clientId}
          onChange={(e) => onChange({ ...value, clientId: e.target.value })}
        />
        {error && <p className="fg-body-sm text-danger">{error}</p>}
      </Field>
    </>
  );
}
