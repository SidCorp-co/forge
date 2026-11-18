import type { ActorAgency } from '@forge/contracts/permissions';

/** What a grant-epoch refusal reads of the credential it refuses, to name who mints it anew. */
export type PatEpochHolder = {
  readonly deviceId: string | null;
  readonly agency: ActorAgency;
  readonly oauthGrantId?: string | undefined;
};

/**
 * The act that gives a credential a later grant epoch. No door raises a credential's epoch in
 * place, so it is always a new mint, by whoever mints that kind: a box's checkout credential is
 * minted at its device credential's epoch, so that one is re-paired before the checkout is
 * re-minted, which a runner re-bind does (ISS-1335).
 */
export function patRemintDoor(holder: PatEpochHolder, epoch: number): string {
  const lead = `No grant raises a credential's epoch in place; a new one is minted at epoch ${epoch}: `;
  if (holder.deviceId !== null) {
    return (
      `${lead}this credential is paired box ${holder.deviceId}'s, and a checkout's credential takes its box's ` +
      'device credential epoch, so a person signed in to Forge re-pairs the box (`forge-runner login`, approved ' +
      "by them), then, as the box's owner and a project admin, re-binds the project's runner to it " +
      "(POST /api/projects/<project id>/runners with its `deviceId`), which re-mints the checkout's credential."
    );
  }
  if (holder.oauthGrantId !== undefined) {
    return `${lead}this is an MCP client's sign-in, so reconnect the client and sign in again.`;
  }
  if (holder.agency === 'agent') {
    return (
      `${lead}an org admin signed in to Forge mints this agent a token ` +
      '(POST /api/orgs/<org id>/agents/<agent id>/tokens).'
    );
  }
  return `${lead}mint a new token under Settings → API Tokens.`;
}
