import { describe, expect, it } from 'vitest';
import { adoptionShortfall } from './adoption-record.js';

const base = {
  ref: 'catalog-api/admin-rest-v1@4.0.0',
  provider: { recorded: new Set(['3.20.0', '4.0.0']) },
  builtAgainst: ['4.0.0'],
  interfaceRevision: 10,
  pins: [
    { modulePath: 'apis/catalog', pinnedVersion: '4.0.0' },
    { modulePath: 'modules/keywords', pinnedVersion: '4.0.0' },
  ],
};

describe('adoptionShortfall (REQ-5 BC-17, BC-18)', () => {
  it('holds when the version is recorded, the interface built against it and every link pinned there', () => {
    expect(adoptionShortfall(base)).toBeNull();
    expect(adoptionShortfall({ ...base, pins: [] })).toBeNull();
  });

  it('names each way the record does not hold', () => {
    expect(adoptionShortfall({ ...base, ref: 'not a ref' })).toContain('is not written as');
    expect(adoptionShortfall({ ...base, provider: null })).toContain(
      'no project holds as its slug',
    );
    expect(adoptionShortfall({ ...base, ref: 'catalog-api/admin-rest-v1@5.0.0' })).toContain(
      'never recorded',
    );
    expect(adoptionShortfall({ ...base, interfaceRevision: null })).toContain(
      'declares no interface',
    );
    expect(adoptionShortfall({ ...base, builtAgainst: [] })).toContain('does not consume');
    expect(adoptionShortfall({ ...base, builtAgainst: ['4.0.0', '3.20.0'] })).toContain(
      'built against 3.20.0, not 4.0.0',
    );
  });

  it('names the links left behind, five at most and a count of the rest', () => {
    const behind = Array.from({ length: 7 }, (_, i) => ({
      modulePath: `apis/m${i}`,
      pinnedVersion: '3.20.0',
    }));
    const said = adoptionShortfall({ ...base, pins: [...base.pins, ...behind] });
    expect(said).toContain(
      "7 of this project's links to catalog-api/admin-rest-v1 are not pinned at 4.0.0",
    );
    expect(said).toContain('apis/m4 at 3.20.0 and 2 more');
    expect(adoptionShortfall({ ...base, pins: [behind[0] as (typeof behind)[number]] })).toContain(
      "1 of this project's links to catalog-api/admin-rest-v1 is not pinned",
    );
  });
});
