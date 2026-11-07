// ISS-1104 (FB-553): a tool call refused for want of a grant told an agent's fenced token to mint
// a token, and one refused as account work told it to use a token with no project list: no token
// mints or widens a token, and an agent never holds an unfenced one. A fenced caller is sent to a
// person through the question door, where its grant opens it; an unfenced one keeps minting.

import { describe, expect, it } from 'vitest';
import { toolCallRefusal } from './tool-call-guard.js';
import type { GrantedTool } from './tool-grant.js';

const writeTool: GrantedTool = {
  name: 'forge_thing',
  inputSchema: { type: 'object' },
  grant: 'issues:write',
  route: '/api/issues',
};
const accountTool: GrantedTool = {
  name: 'forge_project_create',
  inputSchema: { type: 'object' },
  grant: 'projects:write',
  reach: { account: 'creating a project' },
  route: '/api/projects',
};
const bound = (grant: string[], fence: string[] | null) => ({
  grant,
  fence,
  grantEpoch: 3,
  tokenId: 'tok',
});

describe('a tool call refused for its grant', () => {
  it('sends a fenced token to a person through the question door it holds', () => {
    const said = toolCallRefusal(writeTool, {}, bound(['issues:read', 'questions:write'], ['p']));
    expect(said).toContain("needs 'issues:write'");
    expect(said).not.toContain('Mint a token');
    expect(said).toContain('A person signed in to Forge grants it');
    expect(said).toContain('POST /api/questions');
  });

  it('says a fenced token without questions:write cannot ask either', () => {
    const said = toolCallRefusal(writeTool, {}, bound(['issues:read'], ['p']));
    expect(said).toContain("not granted 'questions:write'");
  });

  it('keeps an unfenced token on minting one', () => {
    const said = toolCallRefusal(writeTool, {}, bound(['issues:read'], null));
    expect(said).toContain("Mint a token that includes 'issues:write'");
  });
});

describe('a tool call refused as account work', () => {
  it("reads the token's own grant to say whether it can ask a person", () => {
    const holds = toolCallRefusal(
      accountTool,
      {},
      bound(['projects:write', 'questions:write'], ['p']),
    );
    expect(holds).toContain('PAT_ACCOUNT_ROUTE');
    expect(holds).not.toContain('Use a token with no project list');
    expect(holds).toContain('ask one with POST /api/questions');
    const lacks = toolCallRefusal(accountTool, {}, bound(['projects:write'], ['p']));
    expect(lacks).toContain("not granted 'questions:write'");
  });
});
