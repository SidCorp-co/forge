import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { onArg, permissionless } from '../middleware/declared-permission.js';
import { buildMcpContract, type ListedTool } from './mcp-tools.js';
import { CONTRACTS_DIR } from './routes.js';

// REQ-12 BC-20 (ISS-824): every MCP tool action declares its permission in the published contract,
// and the generator refuses an action that declares none, with no exception.
//
// @direct-test-of packages/core/src/api-contract/declared-permission-field.ts

const input = (actions: string[]) => ({
  type: 'object',
  properties: { action: { type: 'string', enum: actions } },
});

const probe = (permission?: ListedTool['permission']): ListedTool => ({
  name: 'forge_probe',
  description: 'probe',
  inputSchema: input(['read', 'write']),
  ...(permission ? { permission } : {}),
});

describe('every MCP tool action declares its permission (REQ-12 BC-20, ISS-824)', () => {
  it('names it per action, and refuses an action that declares none', () => {
    const { document, refusals } = buildMcpContract(
      [probe({ byAction: { read: onArg('project.read') } })],
      {},
    );
    const [tool] = (document as { tools: Record<string, unknown>[] }).tools;
    expect(tool?.['x-forge-permission']).toEqual({
      read: { permission: 'project.read', on: { arg: 'projectId' } },
    });
    expect(refusals).toEqual([
      expect.stringMatching(/^forge_probe\.write: declares no permission/),
    ]);
  });

  it('passes a tool whose every action declares, and refuses a tool taking no action that declares none', () => {
    const tool = probe({
      byAction: {
        read: permissionless('self', 'the caller’s own rows'),
        write: onArg('project.write'),
      },
    });
    expect(buildMcpContract([tool], {}).refusals).toEqual([]);
    const bare: ListedTool = {
      name: 'forge_bare',
      description: 'bare',
      inputSchema: { type: 'object' },
    };
    expect(buildMcpContract([bare], {}).refusals).toEqual([
      expect.stringMatching(/^forge_bare: declares no permission/),
    ]);
  });

  it('refuses a declaration for an action the tool does not take', () => {
    const tool = probe({
      byAction: {
        read: onArg('project.read'),
        write: onArg('project.write'),
        erase: onArg('project.admin'),
      },
    });
    expect(buildMcpContract([tool], {}).refusals).toEqual([
      'forge_probe.erase: declares a permission for an action the tool does not take',
    ]);
  });
});

describe('the committed MCP contract names a permission on every action', () => {
  const document = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, 'forge-mcp.tools.json'), 'utf8'),
  ) as {
    tools: {
      name: string;
      inputSchema: { properties?: { action?: { enum?: string[] } } };
      'x-forge-permission'?: Record<string, unknown>;
    }[];
  };

  it('carries x-forge-permission on every action, with none left undeclared', () => {
    const without = document.tools.flatMap((t) =>
      (t.inputSchema.properties?.action?.enum ?? [])
        .filter((a) => t['x-forge-permission']?.[a] === undefined)
        .map((a) => `${t.name}.${a}`),
    );
    expect(without).toEqual([]);
  });
});
