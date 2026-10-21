// Core's `ORG_NAME_LIMIT`, held equal by `org-name-limit-parity.test.ts` (ISS-1229 r29).

export const ORG_NAME_LIMIT = 200;

const COUNT_FROM = 180;

export interface OrgNameReading {
  hint?: string;
  error?: string;
}

/** Read trimmed, as core reads a name. */
export function readOrgName(value: string): OrgNameReading {
  const length = value.trim().length;
  const count = `${length} of ${ORG_NAME_LIMIT} characters`;
  if (length > ORG_NAME_LIMIT) {
    return {
      error: `${count}. An organization's name is at most ${ORG_NAME_LIMIT} characters; shorten it to save.`,
    };
  }
  return length > COUNT_FROM ? { hint: count } : {};
}
