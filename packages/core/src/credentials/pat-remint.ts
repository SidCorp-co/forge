import type { ActorAgency } from '@forge/contracts/permissions';

/** What a grant-epoch refusal reads of the credential it refuses, to name who mints it anew. */
export type PatEpochHolder = {
  readonly deviceId: string | null;
  readonly agency: ActorAgency;
  readonly oauthGrantId?: string | undefined;
};

/**
 * The act that gives a credential a later grant epoch. No door raises a credential's epoch in
 * place, so it is always a new mint, by whoever mints that kind: a checkout credential is minted at
 * its runner device's credential epoch, so the device is re-paired before the checkout is
 * re-minted, which a runner re-bind does (ISS-1335). The device is never called a box here, as the
 * refusal often follows a Forge Box refused, and never named by its id, which the runners list holds.
 */
export function patRemintDoor(holder: PatEpochHolder, epoch: number): string {
  const lead = `No grant raises a credential's epoch in place; a new one is minted at epoch ${epoch}: `;
  if (holder.deviceId !== null) {
    return (
      `${lead}this is a checkout credential, which takes its runner device's epoch, so a person signed ` +
      'in to Forge re-pairs the runner device (`forge-runner login`), then, as its owner and a project ' +
      "admin, re-binds the project's runner to it (POST /api/projects/<project id>/runners with " +
      'the `deviceId` GET there lists).'
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
