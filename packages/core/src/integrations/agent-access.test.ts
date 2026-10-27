import { describe, expect, it } from 'vitest';
import { notGrantedMessage } from './agent-access.js';
import { registerAllIntegrations } from './register-all.js';

registerAllIntegrations();

// ISS-1421 r31, judge-127 on 348: an agent's Coolify call read "Binding 189a3bd4-… (coolify) is
// connected but no agent on this project may use it: its agent access is `none`. An org owner or
// admin turns it on … Settings → Integrations", though a project admin who is a plain org member
// set and cleared that grant, and the page labels the provider "Coolify".
describe('notGrantedMessage', () => {
  it('names the provider by its label, the switch in its own words, and who may switch it on', () => {
    expect(
      notGrantedMessage('coolify', { displayName: 'Production box', provider: 'coolify' }),
    ).toBe(
      'This project is connected to Coolify through the connection "Production box", but no agent on this project may use it: its "Agents on this project may use this" switch is off. Only an admin of this project can switch it on, in the Coolify drawer on this project\'s Integrations tab.',
    );
  });

  it("names an owner or admin of the project's organization where the grant hands a box the key", () => {
    expect(notGrantedMessage('sentry')).toContain(
      "Only an owner or admin of this project's organization can switch it on, in the Sentry drawer",
    );
  });

  it('names a project admin for a provider whose calls Forge makes itself', () => {
    expect(notGrantedMessage('google')).toContain(
      'This project is connected to Google Sheets, but no agent',
    );
    expect(notGrantedMessage('google')).toContain('Only an admin of this project can switch it on');
  });

  it('names no binding id, no stored value and no settings path', () => {
    for (const provider of ['coolify', 'google', 'sentry', 'github']) {
      const said = notGrantedMessage(provider);
      expect(said).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|`none`|Settings →|\(coolify\)/);
      expect(said).not.toMatch(new RegExp(`\\b${provider}\\b`));
    }
  });
});
