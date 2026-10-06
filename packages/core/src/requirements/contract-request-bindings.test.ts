import { describe, expect, it } from 'vitest';
import { nodeSchema } from '../workflows/schema.js';
import {
  attachBuildingIssues,
  bindingRefusals,
  bindingsInDocument,
  brokenByOf,
  reaches,
} from './bindings.js';
import { contractRequestRefusal } from './contract-request.js';
import { requestSignoffRefusal } from './request-signoff.js';

const forbidden = {
  code: 'PERMISSION_FORBIDDEN' as const,
  path: '',
  detail: 'needs requirements.approve.',
};

describe('a contract request is signed only by its provider (E2)', () => {
  it('names the requesting project when one of its members tries to sign', () => {
    const r = requestSignoffRefusal({
      refusal: forbidden,
      key: 'REQ-4',
      requestedBy: { id: 'p-consumer', slug: 'shop' },
      signerInRequestingProject: true,
    });
    expect(r?.code).toBe('REQUIREMENT_SIGNOFF_FORBIDDEN');
    expect(r?.detail).toContain('shop');
  });
  it('leaves a stranger refused as a stranger, and an approver here signs', () => {
    const base = { key: 'REQ-4', requestedBy: { id: 'p', slug: 'shop' } };
    expect(
      requestSignoffRefusal({ ...base, refusal: forbidden, signerInRequestingProject: false })
        ?.code,
    ).toBe('PERMISSION_FORBIDDEN');
    expect(requestSignoffRefusal({ ...base, refusal: null, signerInRequestingProject: true })).toBe(
      null,
    );
  });
  it('changes nothing on a requirement written here', () => {
    expect(
      requestSignoffRefusal({
        refusal: forbidden,
        key: 'REQ-1',
        requestedBy: null,
        signerInRequestingProject: true,
      })?.code,
    ).toBe('PERMISSION_FORBIDDEN');
  });
});

describe('what a contract request may name', () => {
  const base = {
    requesterId: 'c',
    providerId: 'p',
    consumes: ['pay/charges'],
    providerPublishes: ['pay/refunds'],
  };
  it('takes a contract the requester consumes or the provider publishes', () => {
    expect(contractRequestRefusal({ ...base, contract: 'pay/charges' })).toBe(null);
    expect(contractRequestRefusal({ ...base, contract: 'pay/refunds' })).toBe(null);
  });
  it('refuses any other contract, and a request to its own project', () => {
    expect(contractRequestRefusal({ ...base, contract: 'pay/payouts' })?.code).toBe(
      'REQUIREMENT_CONTRACT_UNKNOWN',
    );
    expect(
      contractRequestRefusal({ ...base, providerId: 'c', contract: 'pay/charges' })?.code,
    ).toBe('REQUIREMENT_REQUEST_OWN_PROJECT');
  });
});

describe('screen bindings (pins, impact)', () => {
  const design = { workflowId: 'w1', flow: 'checkout', designRevision: 3 };
  const doc = {
    steps: [
      {
        id: 'cart',
        node: {
          type: 'SCREEN',
          binds: [{ provider: 'pay', slug: 'charges', element: 'POST /charges' }],
        },
      },
      { id: 'done', node: { type: 'SCREEN' } },
    ],
  };
  it('reads the binds inside a pinned design, and a design schema carries them', () => {
    expect(bindingsInDocument(design, doc)).toEqual([
      { ...design, step: 'cart', contract: 'pay/charges', element: 'POST /charges' },
    ]);
    expect(nodeSchema.safeParse(doc.steps[0]?.node).success).toBe(true);
  });
  it('refuses a binding to a contract that is not element-indexed, by name', () => {
    const b = {
      ...design,
      step: 'cart',
      contract: 'bus/orders',
      element: 'order.placed',
      pinnedVersion: null,
      brokenBy: null,
      buildingIssues: [],
    };
    for (const type of ['asyncapi', 'protobuf', 'opaque']) {
      const [r] = bindingRefusals([{ ...b, contractType: type }]);
      expect(r?.code).toBe('REQUIREMENT_BINDING_NOT_INDEXED');
      expect(r?.detail).toContain(type);
    }
    expect(bindingRefusals([{ ...b, contractType: 'openapi' }])).toEqual([]);
    expect(bindingRefusals([{ ...b, contractType: null }])).toEqual([]);
  });
  it('names the version past the pin that removed or broke the bound element', () => {
    const v = (
      version: string,
      elements: string[],
      breakingElements: string[] = [],
      approval = 'approved',
    ) => ({
      providerProjectId: 'p',
      contractSlug: 'charges',
      version,
      approval,
      elements,
      breakingElements,
    });
    const versions = [
      v('4.0.0', ['GET /charges'], [], 'proposed'),
      v('3.0.0', ['GET /charges', 'POST /charges'], ['POST /charges/responses/201']),
      v('2.0.0', ['GET /charges', 'POST /charges']),
      v('1.0.0', ['GET /charges', 'POST /charges']),
    ];
    expect(brokenByOf('POST /charges', '1.0.0', versions)).toBe('3.0.0');
    expect(brokenByOf('GET /charges', '1.0.0', versions)).toBe(null);
    expect(brokenByOf('POST /charges', '3.0.0', versions)).toBe(null);
    expect(
      brokenByOf('POST /charges', '1.0.0', [v('2.0.0', ['GET /charges']), versions[3] as never]),
    ).toBe('2.0.0');
    expect(reaches('Query.products', 'Query.products.variants.price')).toBe(true);
    expect(reaches('Query.product', 'Query.products')).toBe(false);
  });
});

describe('impact: the issues building a flow a breaking version reaches', () => {
  const binding = (workflowId: string, brokenBy: string | null) => ({
    workflowId,
    flow: workflowId,
    designRevision: 2,
    step: 'cart',
    contract: 'pay/charges',
    element: 'POST /charges',
    contractType: 'openapi',
    pinnedVersion: '1.0.0',
    brokenBy,
    buildingIssues: [],
  });
  const builds = [
    { issueId: 'i1', workflowId: 'checkout', issSeq: 12, title: 'Cart screen', status: 'open' },
    { issueId: 'i2', workflowId: 'refunds', issSeq: 14, title: 'Refunds', status: 'developed' },
  ];
  const traced = [
    { issueId: 'i3', issSeq: 15, title: 'Pay with a saved card', status: 'in_progress' },
    { issueId: 'i1', issSeq: 12, title: 'Cart screen', status: 'open' },
    { issueId: 'i4', issSeq: 16, title: 'Dropped spike', status: 'dropped' },
  ];
  it('lists the issues building the flow of a broken binding, and none for an unbroken one', () => {
    const [broken, whole] = attachBuildingIssues(
      [binding('checkout', '3.0.0'), binding('refunds', null)],
      builds,
      [],
      'ISS',
    );
    expect(broken?.buildingIssues).toEqual([
      { issueId: 'i1', displayId: 'ISS-12', title: 'Cart screen', status: 'open' },
    ]);
    expect(whole?.buildingIssues).toEqual([]);
  });
  it('names no issue when nothing builds the broken flow', () => {
    const [b] = attachBuildingIssues([binding('search', '3.0.0')], builds, [], 'ISS');
    expect(b?.buildingIssues).toEqual([]);
  });
  it('adds each issue whose criteria trace a BC of the requirement pinning the broken version, once, never a dropped one', () => {
    const [broken, whole] = attachBuildingIssues(
      [binding('checkout', '3.0.0'), binding('refunds', null)],
      builds,
      traced,
      'ISS',
    );
    expect(broken?.buildingIssues).toEqual([
      { issueId: 'i1', displayId: 'ISS-12', title: 'Cart screen', status: 'open' },
      { issueId: 'i3', displayId: 'ISS-15', title: 'Pay with a saved card', status: 'in_progress' },
    ]);
    expect(whole?.buildingIssues).toEqual([]);
  });
  it('names the tracing issues of a broken flow no build link names', () => {
    const [b] = attachBuildingIssues([binding('search', '3.0.0')], builds, traced, 'ISS');
    expect(b?.buildingIssues.map((i) => i.displayId)).toEqual(['ISS-12', 'ISS-15']);
  });
});
