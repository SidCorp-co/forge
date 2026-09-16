/**
 * ISS-1036 — Google service-account provider shapes.
 *
 * The credential is the JSON key file Google issued, stored whole. Nothing in
 * this module names the PEM on its own: `rotation.ts` rotates the file, and the
 * file is what carries the key id Google maps back to the account.
 */

/** Connection-tier config. Both identity fields are written back by the
 *  healthcheck out of the stored key, never typed by an operator. */
export interface GoogleConfig extends Record<string, unknown> {
  clientEmail?: string;
  projectId?: string;
  /** Binding-tier: the spreadsheet a caller naming none is asking about. */
  defaultSpreadsheetId?: string;
}

/** Vault-decrypted secrets for a Google connection. */
export interface GoogleSecrets extends Record<string, unknown> {
  serviceAccountJson?: string;
  previousServiceAccountJson?: string;
  previousTokenExpiresAt?: string;
}

/** The fields of a service-account key file this code reads. Google ships more
 *  and they are kept in the vault; only these are read. */
export interface ServiceAccountKey {
  type: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  token_uri?: string;
}

/**
 * Google refused the credential itself — the token endpoint would not exchange
 * the assertion. Distinct from {@link GoogleApiError}, which is the Sheets API
 * answering about a resource with a credential it already accepted.
 */
export class GoogleAuthError extends Error {
  readonly status: number;
  /** `rejected` = Google will not accept this account; re-entering the same key
   *  reproduces it. `transport` = anything else, including Google being down. */
  readonly kind: 'rejected' | 'transport';
  constructor(status: number, kind: 'rejected' | 'transport', message: string) {
    super(message);
    this.name = 'GoogleAuthError';
    this.status = status;
    this.kind = kind;
  }
}

/** A non-2xx answer from the Sheets API. */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly route: string;
  constructor(status: number, route: string, message: string) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.route = route;
  }
}
