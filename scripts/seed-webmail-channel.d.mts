// Types for `seed-webmail-channel.mjs`, which the channel e2e test runs against a harness core.

export interface SeedMember {
  username: string;
  roles: string[];
  askFor: string;
}

export const MEMBERS: SeedMember[];
export const RULES: string[];

export interface SeededChannel {
  name: string | null;
  memberRows: { username: string; roles: string[]; state: string; askFor: string | null }[];
  ruleRows: { id: string; text: string; author: string | null }[];
}

export function seed(input: {
  base: string;
  token: string;
  project?: string | undefined;
  rid?: string;
  /** A Rocket.Chat connection to bind the group on, where the project has no binding yet. */
  connection?: string;
  dry?: boolean;
  log?: (line: string) => void;
}): Promise<SeededChannel>;
