/**
 * REQ-12 BC-22 (ISS-825): a credential handed to an agent session is a declared egress surface. Each
 * direct-mcp provider names the surface its hand-off passes, the rule passes the entry as it was
 * built at every data level, and a declaration naming none is refused at boot, by name.
 *
 * @direct-test-of packages/core/src/integrations/types.ts
 * @direct-test-of packages/core/src/integrations/mcp-resolver.ts
 * @direct-test-of packages/core/src/lib/data-egress.ts
 */
import { SENSITIVE_DATA_LEVELS } from '@forge/contracts/data-policy';
import { describe, expect, it } from 'vitest';
import { egressAt } from '../lib/data-egress.js';
import { autoflowIntegration } from './autoflow/adapter.js';
import { epodsystemIntegration } from './epodsystem/adapter.js';
import { sentryIntegration } from './sentry/adapter.js';
import { declareIntegration } from './types.js';

const DIRECT = [autoflowIntegration, epodsystemIntegration, sentryIntegration];

describe('a direct-mcp credential hand-off is a declared egress surface', () => {
  it('each direct-mcp provider names one, and the rule passes its entry as built at every level', () => {
    const entry = {
      type: 'http',
      url: 'https://forge.example/api/mcp-relay/x',
      headers: { t: 'k' },
    };
    for (const decl of DIRECT) {
      const path = decl.capabilities.agentPath;
      expect(path.kind, decl.provider).toBe('direct-mcp');
      if (path.kind !== 'direct-mcp') continue;
      expect(path.egressSurface, decl.provider).toBe('integration.credential');
      for (const level of SENSITIVE_DATA_LEVELS) {
        expect(egressAt(level, path.egressSurface, entry), `${decl.provider} at ${level}`).toEqual({
          ok: true,
          value: entry,
        });
      }
    }
  });

  it('refuses a direct-mcp declaration with its surface removed, or one EGRESS_SURFACES lacks, by name', () => {
    const path = sentryIntegration.capabilities.agentPath;
    if (path.kind !== 'direct-mcp') throw new Error('sentry is direct-mcp');
    const { egressSurface: _removed, ...bare } = path;
    const declare = (agentPath: unknown) => () =>
      declareIntegration({
        ...sentryIntegration,
        provider: 'planted',
        capabilities: { ...sentryIntegration.capabilities, agentPath: agentPath as typeof path },
      });
    expect(declare(bare)).toThrow(
      /INTEGRATION_EGRESS_UNDECLARED: provider planted .* names no egress surface/,
    );
    expect(declare({ ...bare, egressSurface: 'mcp.credential' })).toThrow(
      /INTEGRATION_EGRESS_UNDECLARED: .*"mcp\.credential", which lib\/data-egress\.ts:EGRESS_SURFACES does not declare/,
    );
  });
});
