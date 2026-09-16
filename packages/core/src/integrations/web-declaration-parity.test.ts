/**
 * The web's provider registry and core's declarations must agree about how an agent reaches a
 * provider — and nothing else in either package can notice when they stop.
 *
 * `BindingSummary.agentPathKind` is projected by the server for a SAVED binding, so a binding row
 * always renders from the truth. A CONNECT form has no binding yet, so it reads the kind from
 * `web-v2/src/features/integrations/providers/<provider>/index.ts`, which is a second copy. While
 * writing ISS-1071 that copy was already wrong for two of the eight: it called `github` and
 * `rocketchat` `core-mediated` when both declare no agent path at all. The visible effect is a
 * switch offered on a connect form that the server then refuses by name — a person turning on
 * something the product tells them, one request later, was never a question.
 *
 * This test reads the web files as TEXT on purpose. `@forge/core` cannot import a browser module
 * and web-v2 cannot import core's runtime (that would run core's env validation in a Next build), so
 * a type or an import cannot hold the two together. It is the same shape as
 * `deploy-capability-parity.test.ts`, for the same reason.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllIntegrations } from './register-all.js';
import { listIntegrations } from './registry.js';

const PROVIDERS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../web-v2/src/features/integrations/providers',
);

/** `agentPathKind: "…"` out of one web provider module. */
function webAgentPathKind(provider: string): string | null {
  const source = readFileSync(join(PROVIDERS_DIR, provider, 'index.ts'), 'utf8');
  const match = source.match(/agentPathKind:\s*"([a-z-]+)"/);
  return match?.[1] ?? null;
}

describe('the web provider registry agrees with core’s declarations', () => {
  beforeAll(() => {
    registerAllIntegrations();
  });

  it('declares every provider core declares, and no others', () => {
    const core = listIntegrations()
      .map((d) => d.provider as string)
      .sort();
    const web = readdirSync(PROVIDERS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    // A provider in core with no web module is one nobody can connect; a web module for a provider
    // core does not declare is a form whose every submission is refused as an undeclared provider.
    expect(web).toEqual(core);
  });

  it('gives each provider the same agent path kind core declares', () => {
    for (const decl of listIntegrations()) {
      expect(
        webAgentPathKind(decl.provider),
        `web says ${webAgentPathKind(decl.provider)} for ${decl.provider}, core declares ${decl.capabilities.agentPath.kind}`,
      ).toBe(decl.capabilities.agentPath.kind);
    }
  });

  it('offers the grant switch on exactly the providers whose grant can hold', () => {
    // The negative half, stated separately because it is the one that was wrong: a provider with no
    // agent path must render no switch, and the web module saying `none` is what makes that happen.
    const noPath = listIntegrations()
      .filter((d) => d.capabilities.agentPath.kind === 'none')
      .map((d) => d.provider);
    expect(noPath.length).toBeGreaterThan(0);
    for (const provider of noPath) {
      expect(webAgentPathKind(provider)).toBe('none');
    }
  });
});
