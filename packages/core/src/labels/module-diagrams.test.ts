import { describe, expect, it } from 'vitest';

/**
 * ISS-950 — the four generators, which are pure, so everything about their SHAPE is provable here.
 *
 * What is deliberately not here: the co-occurrence self-join, the declared-edge resolution and the
 * retraction window, all of which are SQL and are proved against a real Postgres in
 * `tests/integration/module-diagrams-e2e.test.ts`. A mocked client cannot double-count a pair.
 */

import { ModuleFlowParseError, parseModuleFlow } from './module-diagram-flow.js';
import {
  generateModuleDiagram,
  type ModuleDiagramError,
  type ModuleDiagramSnapshot,
  type ModuleSnapshot,
} from './module-diagrams.js';

const flowBody = (mermaid: string) => `Some prose.\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\nMore.`;

function mod(over: Partial<ModuleSnapshot> & { id: string; name: string }): ModuleSnapshot {
  return {
    slug: over.name.toLowerCase(),
    parentId: null,
    node: null,
    ...over,
  };
}

function snap(over: Partial<ModuleDiagramSnapshot> = {}): ModuleDiagramSnapshot {
  return {
    projectName: 'Forge',
    modules: [],
    coOccurrences: [],
    declaredEdges: [],
    ...over,
  };
}

const withFlow = (mermaid: string, actor: string | null = null) => ({
  body: flowBody(mermaid),
  relatedIssueCount: 0,
  actor,
});

describe('generateModuleDiagram — refusals', () => {
  it('refuses a project with no modules by name rather than drawing an empty frame', () => {
    for (const kind of ['mindmap', 'context', 'user-flow', 'swimlane'] as const) {
      try {
        generateModuleDiagram(kind, snap());
        expect.unreachable(`${kind} answered a project with no modules`);
      } catch (err) {
        expect((err as ModuleDiagramError).code).toBe('NO_MODULES');
      }
    }
  });

  it('refuses user-flow when no module stores a flow', () => {
    const s = snap({ modules: [mod({ id: 'a', name: 'Issues' })] });
    try {
      generateModuleDiagram('user-flow', s);
      expect.unreachable('user-flow answered without a single stored flow');
    } catch (err) {
      expect((err as ModuleDiagramError).code).toBe('NO_MODULE_FLOWS');
    }
  });

  it('refuses an unreadable stored flow by naming the module, with no partial diagram', () => {
    const s = snap({
      modules: [
        mod({ id: 'a', name: 'Issues', node: withFlow('flowchart TD\n  A --> B') }),
        mod({ id: 'b', name: 'Runners', node: withFlow('sequenceDiagram\n  A ->> B: hi') }),
      ],
    });
    try {
      generateModuleDiagram('user-flow', s);
      expect.unreachable('an unreadable flow was answered instead of refused');
    } catch (err) {
      expect((err as ModuleDiagramError).code).toBe('UNPARSABLE_MODULE_FLOW');
      expect((err as ModuleDiagramError).message).toContain('runners');
    }
  });
});

describe('mindmap', () => {
  const modules = [
    mod({
      id: 'root',
      name: 'Issue work',
      node: { body: 'no flow', relatedIssueCount: 7, actor: null },
    }),
    mod({ id: 'child', name: 'Attachments', parentId: 'root' }),
    mod({ id: 'other', name: 'Runners', node: { body: 'x', relatedIssueCount: 0, actor: null } }),
  ];

  it('nests a module under its parent', () => {
    const out = generateModuleDiagram('mindmap', snap({ modules }));
    const lines = out.split('\n');
    const parent = lines.findIndex((l) => l.includes('Issue work'));
    const child = lines.findIndex((l) => l.includes('Attachments'));
    expect(child).toBe(parent + 1);
    const indent = (l: string | undefined) => (l ?? '').match(/^ */)?.[0].length ?? 0;
    expect(indent(lines[child])).toBeGreaterThan(indent(lines[parent]));
  });

  it('carries the bound node’s related-issue count', () => {
    expect(generateModuleDiagram('mindmap', snap({ modules }))).toContain('Issue work (7)');
  });

  it('draws a module with no knowledge node in its place, with no count', () => {
    const out = generateModuleDiagram('mindmap', snap({ modules }));
    expect(out).toContain('Attachments');
    expect(out).not.toContain('Attachments (');
  });

  it('distinguishes a node relating to nothing from a module having no node', () => {
    const out = generateModuleDiagram('mindmap', snap({ modules }));
    expect(out).toContain('Runners (0)');
  });
});

describe('context', () => {
  const modules = [mod({ id: 'a', name: 'Issues' }), mod({ id: 'b', name: 'Runners' })];

  it('labels a co-occurrence edge with the number of issues the pair shares', () => {
    const out = generateModuleDiagram(
      'context',
      snap({ modules, coOccurrences: [{ aId: 'a', bId: 'b', issueCount: 3 }] }),
    );
    expect(out).toContain('3 shared');
  });

  it('draws a declared edge in a different arrow style from a co-occurrence one', () => {
    const out = generateModuleDiagram(
      'context',
      snap({
        modules,
        coOccurrences: [{ aId: 'a', bId: 'b', issueCount: 1 }],
        declaredEdges: [{ fromId: 'a', toId: 'b', predicate: 'dispatches' }],
      }),
    );
    expect(out).toMatch(/-\.->\|"1 shared"\|/);
    expect(out).toMatch(/ -->\|"dispatches"\| /);
  });

  it('escapes the characters mermaid would read as syntax inside a label', () => {
    const out = generateModuleDiagram(
      'context',
      snap({ modules: [mod({ id: 'a', name: 'API "v2" #1' })] }),
    );
    expect(out).not.toMatch(/\["API "v2"/);
    expect(out).toContain('#35;');
  });
});

describe('user-flow', () => {
  const modules = [
    mod({
      id: 'a',
      name: 'Issues',
      node: withFlow('flowchart TD\n  A[Open] -->|triage| B[Planned]\n  B --> C[Shipped]'),
    }),
    mod({
      id: 'b',
      name: 'Runners',
      node: { body: 'prose only', relatedIssueCount: 0, actor: null },
    }),
  ];

  it('gives each module that stores a flow a subgraph of its own', () => {
    const out = generateModuleDiagram('user-flow', snap({ modules }));
    expect(out.match(/subgraph/g)).toHaveLength(1);
    expect(out).toContain('subgraph g0["Issues"]');
  });

  it('keeps the arrow label the stored flow carried', () => {
    expect(generateModuleDiagram('user-flow', snap({ modules }))).toContain('|"triage"|');
  });

  it('keeps a step’s first text when a later arrow names it bare', () => {
    expect(generateModuleDiagram('user-flow', snap({ modules }))).toContain('"Planned"');
  });
});

describe('swimlane', () => {
  const modules = [
    mod({
      id: 'a',
      name: 'Issues',
      node: withFlow('flowchart TD\n  A[File] --> B[Triage]', 'Reporter'),
    }),
    mod({
      id: 'b',
      name: 'Runners',
      node: withFlow('flowchart TD\n  C[Claim] --> D[Build]', 'Reporter'),
    }),
    mod({ id: 'c', name: 'Deploys', node: withFlow('flowchart TD\n  E[Ship] --> F[Verify]') }),
  ];

  it('takes the lane from the node’s declared actor', () => {
    expect(generateModuleDiagram('swimlane', snap({ modules }))).toContain('lane0["Reporter"]');
  });

  it('puts two modules naming the same actor in one lane', () => {
    const out = generateModuleDiagram('swimlane', snap({ modules }));
    expect(out.match(/subgraph/g)).toHaveLength(2);
  });

  it('falls back to the module’s own name where the node declares no actor', () => {
    expect(generateModuleDiagram('swimlane', snap({ modules }))).toContain('lane1["Deploys"]');
  });
});

describe('determinism', () => {
  it('answers byte-identical mermaid for an unchanged snapshot', () => {
    const s = snap({
      modules: [
        mod({ id: 'a', name: 'Issues', node: withFlow('flowchart TD\n  A --> B') }),
        mod({ id: 'b', name: 'Runners', parentId: 'a' }),
      ],
      coOccurrences: [{ aId: 'a', bId: 'b', issueCount: 2 }],
    });
    for (const kind of ['mindmap', 'context', 'user-flow', 'swimlane'] as const) {
      expect(generateModuleDiagram(kind, s)).toBe(generateModuleDiagram(kind, s));
    }
  });
});

describe('parseModuleFlow', () => {
  it('answers null for a node body holding no mermaid fence at all', () => {
    expect(parseModuleFlow('just prose')).toBeNull();
  });

  it('reads a bare arrow and a labelled one', () => {
    const flow = parseModuleFlow(flowBody('flowchart LR\n  A[One] --> B\n  B -->|then| C[Three]'));
    expect(flow?.arrows).toEqual([
      { from: 'A', to: 'B', label: null },
      { from: 'B', to: 'C', label: 'then' },
    ]);
  });

  it('refuses a diagram type it cannot read rather than returning the part it understood', () => {
    expect(() => parseModuleFlow(flowBody('stateDiagram-v2\n  [*] --> Open'))).toThrow(
      ModuleFlowParseError,
    );
  });

  it('refuses a line it cannot read even after a header it could', () => {
    expect(() => parseModuleFlow(flowBody('flowchart TD\n  subgraph x\n  end'))).toThrow(
      ModuleFlowParseError,
    );
  });

  it('ignores comments and blank lines', () => {
    const flow = parseModuleFlow(flowBody('flowchart TD\n\n  %% a note\n  A --> B'));
    expect(flow?.arrows).toHaveLength(1);
  });
});
