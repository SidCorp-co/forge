// How a source host lets a runner's git in (ISS-50, REQ-73 BC-5): a credential minted per ask, or
// Forge's relay where the host mints nothing short-lived a box may hold.

/** What `source-host/host-credential.ts` asks of every provider for one repository git is fetching. */
interface GitCredentialReach {
  /** Whether this binding is complete enough to serve git at all — the provision flag reads it. */
  serves(config: Record<string, unknown>): boolean;
  /** Whether this binding reaches the repository git named by `host` and `path`. */
  reaches(config: Record<string, unknown>, host: string, path: string): boolean;
  /** The binding's repository as a person reads it, for a refusal or a log line. */
  repositoryOf(config: Record<string, unknown>): string;
}

/** A provider whose own short-lived, repository-scoped credential is minted per ask (a GitHub App installation token). */
export interface MintedGitCredential extends GitCredentialReach {
  readonly kind: 'minted';
  mint(args: {
    config: Record<string, unknown>;
    secrets: Record<string, unknown>;
  }): Promise<{ username: string; password: string; expiresAt: string }>;
}

/**
 * A provider that can mint nothing short-lived the box may hold: git goes through Forge's relay
 * (`source-host/git-relay.ts`), and the connection's credential is added on the way out, so it never
 * leaves core (REQ-73 BC-5).
 */
export interface RelayedGitCredential extends GitCredentialReach {
  readonly kind: 'relayed';
  /** Where the repository's smart-HTTP endpoints are (`https://host/group/repo.git`), and the headers that open them. */
  upstream(args: { config: Record<string, unknown>; secrets: Record<string, unknown> }): {
    url: string;
    headers: Record<string, string>;
  };
}

export type GitCredentialMint = MintedGitCredential | RelayedGitCredential;
