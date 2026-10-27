import { describe, expect, it } from 'vitest';
import { cannotDeployMessage } from './binding-shape.js';
import { registerAllIntegrations } from './register-all.js';

registerAllIntegrations();

// ISS-1421 r31, judge-127 on 348: "Forge cannot deploy to `sentry` … Deploy-capable providers:
// coolify, epodsystem, agent." named every provider by its id.
describe('cannotDeployMessage', () => {
  it('names the provider and every one Forge deploys to as the Integrations page labels them', () => {
    const said = cannotDeployMessage('sentry');
    expect(said).toMatch(
      /^Forge cannot deploy to Sentry, so it can be shared with a project only as a service/,
    );
    expect(said).toContain('Coolify');
    expect(said).toContain('Epodsystem');
    expect(said).toContain('Agent release channel');
    expect(said).not.toMatch(/`sentry`|\bcoolify\b|\bepodsystem\b|\bagent\b/);
  });

  it('names Rocket.Chat by its label', () => {
    expect(cannotDeployMessage('rocketchat')).toMatch(/^Forge cannot deploy to Rocket\.Chat,/);
  });
});
