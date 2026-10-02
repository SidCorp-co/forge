import { describe, it } from 'vitest';
import { clone, expectAccepted, expectRefused, read } from './schema.fixture.js';

const hop = read('examples/hop.project.json');
const hopSource = read('examples/hop-source.binding.json');

describe('autoflow documents (ISS-51)', () => {
  it('accepts the HOP project and its autoflow bindings', () => {
    expectAccepted('project', hop);
    expectAccepted('binding', hopSource);
    expectAccepted('binding', read('examples/hop-deploy.binding.json'));
  });

  it('refuses a storefront provider the schema does not know, at its path', () => {
    const d = clone(hop);
    d.source.storefront.provider = 'wix';
    expectRefused('project', d, { path: '/source/storefront/provider', code: 'invalid_value' });
  });

  it('refuses an autoflow binding that names no shop', () => {
    const d = clone(hopSource);
    delete d.target.shop;
    expectRefused('binding', d, { path: '/target/shop', code: 'invalid_type' });
  });

  it('refuses a shop that is not a site slug', () => {
    const d = clone(hopSource);
    d.target.shop = 'hop.auto.sidcorp.co';
    expectRefused('binding', d, { path: '/target/shop', code: 'invalid_format' });
  });
});
