import { REQUIREMENT_READINESS_GATES } from '@forge/contracts/requirements';
import { describe, it } from 'vitest';
import { clone, expectAccepted, expectRefused, read } from './schema.fixture.js';

const project = read('examples/forge-dev.project.json');
const withGate = (requirements: unknown) => ({ ...clone(project), requirements });

describe('requirements.readinessGate in the project config document (ISS-98)', () => {
  it.each(REQUIREMENT_READINESS_GATES)(
    'accepts %s, in zod and in the emitted JSON Schema',
    (gate) => {
      expectAccepted('project', withGate({ readinessGate: gate }));
    },
  );

  it('accepts a document that names none, which reads as off', () => {
    expectAccepted('project', project);
    expectAccepted('project', withGate({}));
  });

  it('refuses a value that is no gate, naming the key', () => {
    expectRefused('project', withGate({ readinessGate: 'strict' }), {
      path: '/requirements/readinessGate',
      code: 'invalid_value',
    });
  });

  it('refuses a boolean, which would read as on or off by guess', () => {
    expectRefused('project', withGate({ readinessGate: true }), {
      path: '/requirements/readinessGate',
      code: 'invalid_value',
    });
  });

  it('refuses a key the block does not define', () => {
    expectRefused('project', withGate({ readinessGate: 'warn', gate: 'x' }), {
      path: '/requirements',
      code: 'unrecognized_keys',
      key: 'gate',
    });
  });
});
