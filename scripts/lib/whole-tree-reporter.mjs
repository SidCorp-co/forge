// `check-whole-tree-gates.mjs --run`'s reporter: per module, the cases that passed or failed and
// every error. vitest's JSON reporter drops a hook's error, so it cannot say why a gate ran nothing.

import { writeFileSync } from 'node:fs';
import process from 'node:process';

export default class WholeTreeReporter {
  onTestRunEnd(testModules) {
    const rows = testModules.map((module) => {
      const suites = [module, ...module.children.allSuites()];
      const errors = suites.flatMap((suite) => suite.errors()).map((e) => e?.message ?? String(e));
      const ran = [...module.children.allTests()].filter((test) =>
        ['passed', 'failed'].includes(test.result().state),
      ).length;
      return { file: module.moduleId, state: module.state(), ran, errors };
    });
    writeFileSync(process.env.WHOLE_TREE_REPORT, JSON.stringify(rows));
  }
}
