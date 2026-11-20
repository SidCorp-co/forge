#!/usr/bin/env node
/**
 * Create a `runner-v*` tag and push it, WITHOUT forcing: a tag that already exists
 * fails the run, because a moved release tag leaves two binaries claiming one
 * version. <tag> <commit> --published <file> [--skip-released] [--output <file>] [--remote <name>]
 * [--cwd <dir>]
 *
 * The dev line's prereleases (`runner-vX.Y.Z-dev.N`, ISS-1358) and `main`'s releases are two
 * lines over shared commits: a commit is refused only where its own line already released it.
 *
 * Released means a GitHub Release is PUBLISHED for the tag (ISS-1373): the tag is cut before
 * the build, so a failed or skipped build leaves a tag that is no release. Where `tag` already
 * stands unpublished at `commit`, it is reused: nothing is pushed, and the release is built
 * under it. `--published` is the file of published tags the workflow read with its token.
 *
 * `--skip-released` is the autorelease's: a push that changes only how the runner is built or
 * tagged lands on a runner commit that may already be released, and there is then nothing new to
 * release. Its commit, released on its own line, cuts nothing and ends with a notice rather than
 * the refusal an explicit cut gets. `--output <file>` appends `owed=true|false` to it (the step's
 * `$GITHUB_OUTPUT`), so the release job runs only where a release is owed.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { lineOf, readPublished, tagsAtCommit } from './next-runner-version.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The commit a tag points at, or null when the tag does not exist. */
export function tagTarget(cwd, tag) {
  try {
    return git(cwd, ['rev-list', '-n', '1', `refs/tags/${tag}`]).trim();
  } catch {
    return null;
  }
}

/** The `runner-v*` tags on `tag`'s line at `commit`, split by whether a release is published. */
function standingAt(cwd, commit, tag, published) {
  let atCommit;
  try {
    atCommit = git(cwd, ['tag', '--points-at', commit, '--list', 'runner-v*'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    // A failed read is not "no tag here": reading it as one would cut a tag beside a release.
    const why = (err instanceof Error && (err.stderr || err.message)) || String(err);
    throw new Error(
      `reading the runner tags at ${commit} failed, so whether it is already released is ` +
        `unknown: git tag --points-at: ${String(why).trim()}. Nothing was pushed.`,
    );
  }
  return tagsAtCommit(atCommit, published, lineOf(tag));
}

/** The tags on `tag`'s line at `commit` that carry a published GitHub Release, if any. */
export function releasesAt(cwd, commit, tag, published) {
  return standingAt(cwd, commit, tag, published).released;
}

/**
 * Create `tag` at `commit`, or reuse it where it already stands there unpublished. Refuses an
 * already-released commit, a tag standing elsewhere, and a new tag beside an unpublished one.
 * With `skipReleased`, an already-released commit cuts nothing and answers `released` instead.
 */
export function cutRunnerTag({
  cwd,
  tag,
  commit,
  remote = 'origin',
  published,
  skipReleased = false,
}) {
  if (published === undefined || published === null) {
    throw new Error(
      'the published releases are required (--published <file>): without them a tag whose ' +
        'build never published cannot be told from a release. Nothing was pushed.',
    );
  }
  // A rerun of an older run allocates a HIGHER version from today's tags and would
  // publish yesterday's code under it: numerically forward, functionally back.
  const { released: already, unpublished } = standingAt(cwd, commit, tag, published);
  if (already.length > 0 && skipReleased) {
    return { tag, commit, reused: false, released: already };
  }
  if (already.length > 0) {
    throw new Error(
      `${commit} is already released as ${already.join(', ')} — nothing to release, and ` +
        `cutting ${tag} here would publish that code under a higher version than what ` +
        `followed it. Nothing was pushed.`,
    );
  }
  if (unpublished.includes(tag)) {
    // Its build failed or was skipped: the release is still owed, under this same tag.
    return { tag, commit, reused: true };
  }
  if (unpublished.length > 0) {
    throw new Error(
      `${commit} carries ${unpublished.join(', ')} with no published release — release it under ` +
        `that tag rather than cutting ${tag} beside it. Nothing was pushed.`,
    );
  }
  const existing = tagTarget(cwd, tag);
  if (existing !== null) {
    throw new Error(
      `${tag} already exists at ${existing} — a release tag is never moved. ` +
        `Nothing was pushed. If this release has to be recut, delete the tag and its ` +
        `GitHub Release first, and read /api/install/latest.json back afterwards.`,
    );
  }
  git(cwd, ['tag', tag, commit]);
  try {
    git(cwd, ['push', remote, `refs/tags/${tag}`]);
  } catch (err) {
    // Somebody else cut it between the read above and this push. Take the local tag
    // back off so a rerun sees the world rather than a half-made release.
    git(cwd, ['tag', '-d', tag]);
    throw new Error(
      `pushing ${tag} to ${remote} was refused, so no release was cut: ` +
        `${err instanceof Error ? err.message.trim() : String(err)}`,
    );
  }
  return { tag, commit, reused: false };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  const flags = ['--skip-released'];
  const takesValue = (a) => a?.startsWith('--') && !flags.includes(a);
  const positional = args.filter((a, i) => !a.startsWith('--') && !takesValue(args[i - 1]));
  const [tag, commit] = positional;
  if (!tag || !commit) {
    throw new Error(
      'usage: cut-runner-tag.mjs <tag> <commit> --published <file> [--skip-released] ' +
        '[--output <file>] [--remote <name>] [--cwd <dir>]',
    );
  }
  const publishedFile = opt('published', undefined);
  const output = opt('output', undefined);
  const { reused, released } = cutRunnerTag({
    cwd: opt('cwd', process.cwd()),
    tag,
    commit,
    remote: opt('remote', 'origin'),
    published: publishedFile === undefined ? undefined : readPublished(publishedFile),
    skipReleased: args.includes('--skip-released'),
  });
  if (output !== undefined) appendFileSync(output, `owed=${released === undefined}\n`);
  process.stdout.write(
    released !== undefined
      ? `::notice::${commit} is already released as ${released.join(', ')} on its line — nothing ` +
          `new to release, so no tag was cut and no release is built\n`
      : reused
        ? `${tag} stands at ${commit} with no published release — releasing under it, nothing pushed\n`
        : `cut ${tag} at ${commit}\n`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`cut-runner-tag: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
