import { describe, expect, it } from 'vitest';
import { credentialAgency } from '../auth/pat-principal.js';
import { ActorAgencyUndetermined, actorAgency } from './actor-agency.js';

describe('credentialAgency — who acts with a token', () => {
  it("a token bound to a paired box is the box's, an agent, whoever holds it", () => {
    expect(credentialAgency({ ownerKind: 'human', deviceId: 'd1' })).toBe('agent');
    expect(credentialAgency({ ownerKind: 'agent', deviceId: 'd1' })).toBe('agent');
  });

  it("an unbound token is its holder's: a person's stays a person's", () => {
    expect(credentialAgency({ ownerKind: 'human', deviceId: null })).toBe('human');
    expect(credentialAgency({ ownerKind: 'agent', deviceId: null })).toBe('agent');
  });
});

describe('actorAgency — the agency an audit row records', () => {
  it('a device is an agent and a user carries its own', () => {
    expect(actorAgency({ type: 'device' })).toBe('agent');
    expect(actorAgency({ type: 'user', agency: 'human' })).toBe('human');
    expect(actorAgency({ type: 'user', agency: 'agent' })).toBe('agent');
  });

  it('refuses a user actor that carries none, rather than recording a person', () => {
    expect(() => actorAgency({ type: 'user' })).toThrow(ActorAgencyUndetermined);
    expect(() => actorAgency({ type: 'user' })).toThrow(/ACTOR_AGENCY_UNDETERMINED/);
  });
});
