import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergePath, patternCovers, routeFences } from './route-fences.mjs';

const FENCE = { file: 'auth/pat-scope.ts', name: 'fencedProjectIds' };

const BASE = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
    include: ['src/**/*'],
  }),
  'src/router.ts': `export class Router {
  get(..._a: unknown[]) { return this; }
  post(..._a: unknown[]) { return this; }
  use(..._a: unknown[]) { return this; }
  route(_p: string, _r: Router) { return this; }
}
`,
  'src/auth/pat-scope.ts': `export function fencedProjectIds(): string[] | null { return null; }
`,
  'src/lib/authz.ts': `import { fencedProjectIds } from '../auth/pat-scope.js';
export async function loadProjectAccess(id: string) {
  const fence = fencedProjectIds();
  if (fence && !fence.includes(id)) throw new Error('404');
  return { id };
}
`,
  'src/items/service.ts': `import { loadProjectAccess } from '../lib/authz.js';
export async function getItem(id: string) {
  await loadProjectAccess(id);
  return { id };
}
export async function listEverything() {
  return [];
}
`,
};

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'route-fences-'));
  for (const [rel, text] of Object.entries({ ...BASE, ...files })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return routeFences({ coreDir: dir, entry: 'src/index.ts', appName: 'app', fence: FENCE });
}

const verdicts = (proof) =>
  Object.fromEntries(proof.registrations.map((r) => [`${r.method} ${r.path}`, r.fenced]));

const ITEMS = `import { Router } from '../router.js';
import { getItem, listEverything } from './service.js';
export const itemRoutes = new Router();
itemRoutes.get('/:id', async (c: any) => getItem(c.id));
itemRoutes.get('/', async () => listEverything());
`;

describe('routeFences', () => {
  it('reads fencing per function, so a module fencing one route lends nothing to its neighbour', () => {
    const proof = fixture({
      'src/items/routes.ts': ITEMS,
      'src/index.ts': `import { Router } from './router.js';
import { itemRoutes } from './items/routes.js';
export const app = new Router();
app.route('/api/items', itemRoutes);
`,
    });
    expect(verdicts(proof)).toEqual({ 'GET /api/items/:id': true, 'GET /api/items': false });
  });

  it('follows a router handed to a registering function, and a for-of over literal paths', () => {
    const proof = fixture({
      'src/items/extra.ts': `import type { Router } from '../router.js';
import { getItem } from './service.js';
export function registerExtra(router: Router): void {
  for (const at of ['/:id/a', '/:id/b']) router.post(at, async (c: any) => getItem(c.id));
}
`,
      'src/index.ts': `import { Router } from './router.js';
import { registerExtra } from './items/extra.js';
export const app = new Router();
const items = new Router();
registerExtra(items);
app.route('/api/items', items);
`,
    });
    expect(verdicts(proof)).toEqual({
      'POST /api/items/:id/a': true,
      'POST /api/items/:id/b': true,
    });
  });

  it('counts a fencing middleware only for the routes registered after it that it covers', () => {
    const proof = fixture({
      'src/index.ts': `import { Router } from './router.js';
import { loadProjectAccess } from './lib/authz.js';
export const app = new Router();
app.get('/api/p/:id/early', () => 1);
app.use('/api/p/:id/*', async (c: any) => loadProjectAccess(c.id));
app.get('/api/p/:id/late', () => 1);
app.get('/api/q/:id', () => 1);
`,
    });
    expect(verdicts(proof)).toEqual({
      'GET /api/p/:id/early': false,
      'GET /api/p/:id/late': true,
      'GET /api/q/:id': false,
    });
  });

  it('does not take a function that only shares the fence its name for the fence', () => {
    const proof = fixture({
      'src/index.ts': `import { Router } from './router.js';
function fencedProjectIds() { return null; }
export const app = new Router();
app.get('/api/x', () => fencedProjectIds());
`,
    });
    expect(verdicts(proof)).toEqual({ 'GET /api/x': false });
  });

  it('names a registration whose path it cannot read instead of skipping it silently', () => {
    const proof = fixture({
      'src/index.ts': `import { Router } from './router.js';
export const app = new Router();
const at = ['/api/x'].join('');
app.get(at, () => 1);
`,
    });
    expect(proof.registrations).toEqual([]);
    expect(proof.unreadable).toEqual([
      { file: 'index.ts', line: 4, why: 'a .get() whose path is not a literal' },
    ]);
  });

  it('refuses to run when the fence is not where it is declared to be', () => {
    expect(() =>
      fixture({
        'src/auth/pat-scope.ts': 'export const nothing = 1;\n',
        'src/index.ts': `import './auth/pat-scope.js';
import { Router } from './router.js';
export const app = new Router();
`,
      }),
    ).toThrow('the fence fencedProjectIds is not declared in auth/pat-scope.ts');
  });
});

describe('mergePath', () => {
  it.each([
    ['/', '/health', '/health'],
    ['/api/items', '/', '/api/items'],
    ['/api/items', '/:id', '/api/items/:id'],
    ['/api/items', '*', '/api/items/*'],
    ['/', '/', '/'],
  ])('joins %s and %s as Hono does', (base, sub, want) => {
    expect(mergePath(base, sub)).toBe(want);
  });
});

describe('patternCovers', () => {
  it.each([
    ['/api/p/:id/*', '/api/p/:id/late', true],
    ['/api/p/:id/*', '/api/q/:id', false],
    ['/api/p/:id', '/api/p/:id', true],
    ['/api/p/:id', '/api/p/:id/more', false],
    ['*', '/anything/at/all', true],
  ])('%s covering %s is %s', (pattern, path, want) => {
    expect(patternCovers(pattern, path)).toBe(want);
  });
});
