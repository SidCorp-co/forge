#!/usr/bin/env node
// ISS-824 part 6, kept for the record: a service whose check is `requireCan` with a fixed permission
// on the project its route's path names checks it with `requireDeclaredOn` instead, which skips only
// where that route already checked exactly that permission on that very project. Only the literal
// `projectResource(projectId)` shape is rewritten; a check on a row's project is left as it is.
//
//   node scripts/codemod-declared-on-service.mjs <file>...
import { readFileSync, writeFileSync } from 'node:fs';

const CHECK =
  /await requireCan\(actorFor\((\w+(?:\.\w+)?)\), ('[a-z.]+'), projectResource\(projectId\)\);/g;

for (const file of process.argv.slice(2)) {
  const before = readFileSync(file, 'utf8');
  let n = 0;
  let after = before.replace(CHECK, (_m, who, permission) => {
    n += 1;
    return `await requireDeclaredOn(projectId, ${who}, ${permission});`;
  });
  if (n === 0) {
    console.log(`${file}: no fixed check on projectId`);
    continue;
  }
  after = after.replace(
    /import \{([^}]*)\} from '((?:\.\.\/)+permissions\/index\.js)';/,
    (_m, names, from) => {
      const kept = names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((name) => {
          if (!['actorFor', 'projectResource', 'requireCan'].includes(name)) return true;
          const uses = after.split(new RegExp(`\\b${name}\\b`)).length - 1;
          return uses > 1;
        });
      if (!kept.includes('requireDeclaredOn')) kept.push('requireDeclaredOn');
      kept.sort((a, b) => a.replace(/^type /, '').localeCompare(b.replace(/^type /, '')));
      return `import { ${kept.join(', ')} } from '${from}';`;
    },
  );
  writeFileSync(file, after);
  console.log(`${file}: ${n} check(s) now requireDeclaredOn`);
}
