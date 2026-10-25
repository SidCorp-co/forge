import { describe, expect, it } from 'vitest';

(await import('./register-all.js')).registerAllIntegrations();

const { bindingActs, projectIntegrationActs } = await import('./binding-acts.js');
const { agentAccessTier } = await import('./agent-access.js');
const { getIntegration, listIntegrations } = await import('./registry.js');

type Role = 'admin' | 'member' | 'viewer';
type OrgRole = 'owner' | 'admin' | 'member';

const ORG = 'org-1';
const ME = 'user-me';
const reader = (role: Role, orgRole: OrgRole | null) => ({
  userId: ME,
  role,
  projectOrgRole: orgRole,
  orgRoles: new Map(orgRole ? [[ORG, orgRole] as const] : []),
});
const orgs = { ownerType: 'org' as const, ownerId: ORG };
const mine = { ownerType: 'user' as const, ownerId: ME };
const someoneElses = { ownerType: 'user' as const, ownerId: 'user-other' };

const providerOfTier = (tier: 'project-admin' | 'org-admin') => {
  const found = listIntegrations().find(
    (d) => agentAccessTier(getIntegration(d.provider)) === tier,
  );
  if (!found) throw new Error(`no provider declares the ${tier} agent tier`);
  return found.provider;
};

describe('bindingActs — one rule for what a drawer offers and a door accepts (ISS-1421 r27)', () => {
  const provider = providerOfTier('project-admin');

  it('lets a project admin change the binding; a member and a viewer not', () => {
    expect(bindingActs(reader('admin', 'member'), orgs, provider).change).toBe(true);
    expect(bindingActs(reader('member', 'member'), orgs, provider).change).toBe(false);
    expect(bindingActs(reader('viewer', 'member'), orgs, provider).change).toBe(false);
  });

  it("saves an organization's key only for its owners and admins", () => {
    expect(bindingActs(reader('admin', 'member'), orgs, provider).saveKey).toBe(false);
    expect(bindingActs(reader('admin', 'admin'), orgs, provider).saveKey).toBe(true);
    expect(bindingActs(reader('member', 'owner'), orgs, provider).saveKey).toBe(true);
  });

  it("saves a person's key for its owner and any admin of the project, never a plain member", () => {
    expect(bindingActs(reader('admin', 'member'), someoneElses, provider).saveKey).toBe(true);
    expect(bindingActs(reader('member', 'member'), someoneElses, provider).saveKey).toBe(false);
    expect(bindingActs(reader('member', 'member'), mine, provider).saveKey).toBe(true);
  });

  it('turns a connection on only for those who manage it', () => {
    expect(bindingActs(reader('admin', 'member'), someoneElses, provider).turnOn).toBe(false);
    expect(bindingActs(reader('member', 'member'), mine, provider).turnOn).toBe(true);
    expect(bindingActs(reader('admin', 'member'), orgs, provider).turnOn).toBe(false);
    expect(bindingActs(reader('admin', 'admin'), orgs, provider).turnOn).toBe(true);
  });

  it('names who may each act whether or not the reader may', () => {
    const acts = bindingActs(reader('member', 'member'), someoneElses, provider);
    expect(acts.whoChanges).toBe('an admin of this project');
    expect(acts.whoSavesKey).toBe('its owner or an admin of a project bound to it');
    expect(acts.whoTurnsOn).toBe('its owner');
    expect(bindingActs(reader('member', 'member'), orgs, provider).whoSavesKey).toBe(
      'an owner or admin of the organization that owns it',
    );
  });

  it('grants agents a box-held credential only for an admin of the project’s organization', () => {
    const box = providerOfTier('org-admin');
    expect(bindingActs(reader('admin', 'member'), orgs, box).grantAgents).toBe(false);
    expect(bindingActs(reader('admin', 'admin'), orgs, box).grantAgents).toBe(true);
    expect(bindingActs(reader('admin', 'member'), orgs, box).whoGrantsAgents).toBe(
      "an owner or admin of this project's organization",
    );
    expect(bindingActs(reader('admin', 'member'), orgs, provider).grantAgents).toBe(true);
    expect(bindingActs(reader('member', 'owner'), orgs, provider).grantAgents).toBe(false);
  });

  it('lets only a project admin connect a provider', () => {
    expect(projectIntegrationActs({ role: 'admin', projectOrgRole: 'member' }).connect).toBe(true);
    expect(projectIntegrationActs({ role: 'member', projectOrgRole: 'owner' }).connect).toBe(false);
    expect(projectIntegrationActs({ role: 'admin', projectOrgRole: 'member' }).grantBoxAgents).toBe(
      false,
    );
    expect(projectIntegrationActs({ role: 'admin', projectOrgRole: 'admin' }).grantBoxAgents).toBe(
      true,
    );
  });

  it("lets only an owner or admin of the project's organization change the project's own settings", () => {
    expect(
      projectIntegrationActs({ role: 'admin', projectOrgRole: 'member' }).changeProjectSettings,
    ).toBe(false);
    expect(
      projectIntegrationActs({ role: 'member', projectOrgRole: 'admin' }).changeProjectSettings,
    ).toBe(true);
    expect(
      projectIntegrationActs({ role: 'admin', projectOrgRole: null }).changeProjectSettings,
    ).toBe(false);
  });
});
