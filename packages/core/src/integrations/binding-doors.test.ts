import { describe, expect, it } from 'vitest';

(await import('./register-all.js')).registerAllIntegrations();

const { refuseByTier, refuseNewBinding } = await import('./binding-doors.js');
const { agentAccessTier, noAgentPathMessage } = await import('./agent-access.js');
const { getIntegration, listIntegrations } = await import('./registry.js');
const { noKeyToSaveMessage } = await import('./provider-schemas.js');

type Role = 'admin' | 'member' | 'viewer';
type OrgRole = 'owner' | 'admin' | 'member';

const ORG = 'org-1';
const reader = (role: Role, orgRole: OrgRole | null) => ({
  userId: 'user-me',
  role,
  projectOrgId: ORG,
  projectOrgRole: orgRole,
  orgRoles: new Map(orgRole ? [[ORG, orgRole] as const] : []),
});
const orgs = { ownerType: 'org' as const, ownerId: ORG, config: {} };
const someoneElses = { ownerType: 'user' as const, ownerId: 'user-other', config: {} };

const providerOfTier = (tier: 'project-admin' | 'org-admin' | 'refused') => {
  const found = listIntegrations().find(
    (d) => agentAccessTier(getIntegration(d.provider)) === tier,
  );
  if (!found) throw new Error(`no provider declares the ${tier} agent tier`);
  return found.provider;
};

/** The refusal `fn` throws, as status and the sentence it carries; null where it throws nothing. */
function refusal(fn: () => void): { status: number; message: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    const e = err as { status: number; message: string; cause?: { details?: unknown } };
    const details = e.cause?.details;
    return { status: e.status, message: typeof details === 'string' ? details : e.message };
  }
}

const noTiers = {};
const keyTier = { mergedConfig: {} };

describe('refuseByTier — the acts a binding PATCH carries (ISS-1421 r28)', () => {
  const plain = providerOfTier('project-admin');
  const box = providerOfTier('org-admin');
  const none = providerOfTier('refused');

  it("names the organization's people, never a project admin, for a member's key and switch-on together (308)", () => {
    const said = refusal(() =>
      refuseByTier(
        reader('member', 'member'),
        { provider: plain },
        orgs,
        { active: true, secrets: { token: 'x' } },
        noTiers,
      ),
    );
    expect(said?.status).toBe(403);
    expect(said?.message).toBe(
      "You are a member of this project, and you may not switch this integration or change its settings here, nor change its connection's key or shared settings. Only an owner or admin of this project's organization can do all of that, so ask one of them.",
    );
  });

  it("names a project admin for a member's key and switch on a person's connection, which a project admin may save", () => {
    const said = refusal(() =>
      refuseByTier(
        reader('member', 'member'),
        { provider: plain },
        someoneElses,
        { active: true },
        keyTier,
      ),
    );
    expect(said?.message).toContain('Only an admin of this project can do all of that');
  });

  it("names the project's organization for a box-held grant from a plain member or a project admin (314)", () => {
    for (const r of [
      reader('member', 'member'),
      reader('viewer', 'member'),
      reader('admin', 'member'),
    ]) {
      const said = refusal(() =>
        refuseByTier(r, { provider: box }, orgs, { agentAccess: 'all' }, noTiers),
      );
      expect(said?.status).toBe(403);
      expect(said?.message).toContain(
        "so only an owner or admin of this project's organization can change it",
      );
    }
    expect(
      refusal(() =>
        refuseByTier(
          reader('admin', 'admin'),
          { provider: box },
          orgs,
          { agentAccess: 'all' },
          noTiers,
        ),
      ),
    ).toBeNull();
  });

  it('refuses a grant on a provider with no agent path by that, whoever asks (325)', () => {
    for (const r of [reader('admin', 'owner'), reader('member', 'member')]) {
      const said = refusal(() =>
        refuseByTier(r, { provider: none }, orgs, { agentAccess: 'all', active: false }, noTiers),
      );
      expect(said?.status).toBe(400);
      expect(said?.message).toBe(noAgentPathMessage(none));
      // ISS-1421 r29: it read "`rocketchat` declares no agent path … a provider core answers tools from".
      expect(said?.message).not.toMatch(/`|\bcore\b|agent path/);
      expect(said?.message).toContain(getIntegration(none)?.presentation?.label ?? none);
    }
  });

  it('refuses a key sent to a provider that keeps none, whoever asks, an empty one included', () => {
    const keyless = listIntegrations().find((d) => !d.schemas.primaryCredentialField)?.provider;
    if (!keyless) throw new Error('no provider keeps no key');
    for (const r of [reader('admin', 'owner'), reader('member', 'member')]) {
      const said = refusal(() =>
        refuseByTier(r, { provider: keyless }, orgs, { secrets: { token: 'x' } }, noTiers),
      );
      expect(said?.status).toBe(400);
      expect(said?.message).toBe(noKeyToSaveMessage(keyless));
    }
    // ISS-1421 r29: an empty set of keys was answered 200; it is refused like any key.
    const empty = { active: true, secrets: {} };
    const said = refusal(() =>
      refuseByTier(reader('admin', 'owner'), { provider: keyless }, orgs, empty, noTiers),
    );
    expect(said?.status).toBe(400);
    expect(said?.message).toBe(noKeyToSaveMessage(keyless));
    expect(
      refusal(() =>
        refuseByTier(
          reader('admin', 'owner'),
          { provider: keyless },
          orgs,
          { active: true },
          noTiers,
        ),
      ),
    ).toBeNull();
  });

  it('answers one act alone by its own refusal', () => {
    const said = refusal(() =>
      refuseByTier(
        reader('member', 'member'),
        { provider: plain },
        orgs,
        { active: false },
        noTiers,
      ),
    );
    expect(said?.message).toBe(
      'You are a member of this project, so you cannot switch this integration or change its settings here. Only an admin of this project can, so ask one of them.',
    );
    const grant = refusal(() =>
      refuseByTier(
        reader('member', 'member'),
        { provider: plain },
        orgs,
        { agentAccess: 'all' },
        noTiers,
      ),
    );
    expect(grant?.message).toBe(
      "You are a member of this project, so you cannot change whether this project's agents may use it. Only an admin of this project can, so ask one of them.",
    );
  });
});

describe('refuseNewBinding — the create and share doors (ISS-1421 r28)', () => {
  const box = providerOfTier('org-admin');
  const none = providerOfTier('refused');
  const asks = { act: 'connect an integration to it', grants: true, orgOwned: false };

  it("names the project's organization where a member connects a box-held provider with a grant", () => {
    const said = refusal(() => refuseNewBinding(reader('member', 'member'), box, asks));
    expect(said?.message).toBe(
      "You are a member of this project, and you may not connect an integration to it, nor let this project's agents use it. Only an owner or admin of this project's organization can do all of that, so ask one of them.",
    );
  });

  it('refuses a project admin the box grant alone, and takes it from an organization admin', () => {
    expect(
      refusal(() => refuseNewBinding(reader('admin', 'member'), box, asks))?.message,
    ).toContain('hands its credential to the runner box');
    expect(refusal(() => refuseNewBinding(reader('admin', 'admin'), box, asks))).toBeNull();
  });

  it('refuses a grant on a provider with no agent path before any role', () => {
    expect(refusal(() => refuseNewBinding(reader('member', null), none, asks))?.status).toBe(400);
  });

  it("names the organization's people for a member creating a connection the organization owns", () => {
    const said = refusal(() =>
      refuseNewBinding(reader('member', 'member'), box, { ...asks, grants: false, orgOwned: true }),
    );
    expect(said?.message).toContain(
      "you may not connect an integration to it, nor create a connection its organization owns. Only an owner or admin of this project's organization",
    );
  });
});
