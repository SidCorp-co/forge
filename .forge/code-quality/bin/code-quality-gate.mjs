#!/usr/bin/env node

// A developer/CI gate, intentionally separate from any production build: it
// reports only the rules this plugin enables and ignores every other finding.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import {
  CROWDED_DIRECTORY_DIRECTIVE,
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_MAX_FILES_PER_DIRECTORY,
  DEFAULT_STYLESHEET_EXTENSIONS,
  directivesFor,
  ESLINT_CONFIG_FILES,
  findArbitrarySizesInFiles,
  findContrastFailures,
  findCrowdedDirectories,
  findInlineWarningGaps,
  findRampGaps,
  findRawColorsInFiles,
  findRedundantOverrides,
  findUnknownTokens,
  FIX_POLICY,
  RULE_IDS,
  SETTINGS_FILE,
  SOURCE_EXTENSIONS,
  sourceFiles,
  THEME_OVERRIDE_DIRECTIVE,
  TOKEN_SECTIONS,
  TYPE_RAMP_DIRECTIVE,
  UNKNOWN_TOKEN_DIRECTIVE,
  walkDirectories,
} from "../src/index.js";

const USAGE = `Usage: code-quality-gate [paths...] [options]

  --config=FILE           settings file (default ${SETTINGS_FILE}, in the run directory)
  --no-config             ignore it and run the ESLint half alone
  --max-files-per-dir=N   directory width limit (default ${DEFAULT_MAX_FILES_PER_DIRECTORY})
  --ignore-dir=a,b        directory names to skip, added to the defaults
  --ext=.vue,.svelte      extra source extensions to count
  --no-folder-check       skip the directory width check
  --no-inline-warning     skip the form-control inline error check
  --inline-warning-all    judge feature screens too, not the design system alone
  --help                  show this message

${SETTINGS_FILE} settles every flag above, plus the checks ESLint cannot answer, so a
configured project needs none of them:

  { "allRules": true, "maxFilesPerDirectory": 10, "tokenFile": "app/globals.css",
    "stylesheets": {}, "sizes": {}, "typeRamp": {}, "contrast": {}, "unknownTokens": {} }

Fails on this plugin's rules reported as errors, and on directories over the width
limit. "allRules": true widens the first half to every rule the project sets to
error. Warnings never fail.
`;

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const roots = args.filter((argument) => !argument.startsWith("-"));
if (roots.length === 0) roots.push(".");

function listFlag(name) {
  const flag = args.find((argument) => argument.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1).split(",").filter(Boolean) : [];
}

/** The project's settings. Every flag overrides one for a single run. */
function readSettings() {
  if (args.includes("--no-config")) return { home: process.cwd(), settings: {} };
  const [named] = listFlag("--config");
  const file = named ?? SETTINGS_FILE;
  try {
    return { home: path.dirname(path.resolve(file)), settings: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    // A project that never wrote one has not misconfigured itself; a named one is a promise.
    if (error.code === "ENOENT" && named === undefined) return { home: process.cwd(), settings: {} };
    process.stderr.write(`code-quality-gate: cannot read ${file}: ${error.message}\n`);
    return process.exit(2);
  }
}

const { home: settingsHome, settings } = readSettings();

const [limit] = listFlag("--max-files-per-dir");
const maxFilesPerDirectory = Number(
  limit ?? settings.maxFilesPerDirectory ?? DEFAULT_MAX_FILES_PER_DIRECTORY,
);
if (!Number.isInteger(maxFilesPerDirectory) || maxFilesPerDirectory < 1) {
  process.stderr.write("code-quality-gate: the directory width limit needs a positive integer\n");
  process.exit(2);
}

const ignoredDirectories = new Set([
  ...DEFAULT_IGNORED_DIRECTORIES,
  ...(settings.ignoreDirs ?? []),
  ...listFlag("--ignore-dir"),
]);
const extensions = new Set([
  ...SOURCE_EXTENSIONS,
  ...[...(settings.ext ?? []), ...listFlag("--ext")].map((value) =>
    (value.startsWith(".") ? value : `.${value}`).toLowerCase(),
  ),
]);

const BLOCKING_RULES = new Set(RULE_IDS);
const onUnless = (flag, key) => !args.includes(flag) && settings[key] !== false;
const offUntil = (flag, key) => args.includes(flag) || settings[key] === true;

// Severity is the project's own decision to gate or merely observe; `allRules` is its
// decision that one command should gate everything, not this plugin's half.
const allRules = offUntil("--all-rules", "allRules");
const folderCheck = onUnless("--no-folder-check", "folderCheck");
const inlineWarning = onUnless("--no-inline-warning", "inlineWarning");
const inlineWarningAll = offUntil("--inline-warning-all", "inlineWarningAll");

const hasConfig = (dir) => ESLINT_CONFIG_FILES.some((name) => existsSync(path.join(dir, name)));

/**
 * The directories to lint from. ESLint resolves flat config from the working directory
 * upwards, so anywhere under a configured project is already answered. Only when nothing
 * above holds a config does the gate look down: a repository keeping its packages side by
 * side has none at its root, and ESLint throws there rather than finding them.
 */
function workspaces() {
  const here = process.cwd();
  for (let directory = here; ; directory = path.dirname(directory)) {
    if (hasConfig(directory)) return [here];
    if (path.dirname(directory) === directory) break;
  }

  // A configured directory is a package root and its children are ESLint's problem, not this
  // walk's — so finding one is what stops the descent rather than a filter after the fact.
  const found = [];
  const descend = (child) => {
    if (!hasConfig(child)) return true;
    found.push(child);
    return false;
  };
  const walk = walkDirectories([here], { descend });
  while (found.length < 50 && !walk.next().done);
  return found;
}

const targets = workspaces();
if (targets.length === 0) {
  process.stderr.write("code-quality-gate: no ESLint config here or in any package below it\n");
  process.exit(2);
}

const eslint = new ESLint({ cwd: targets[0] });
const results = (
  await Promise.all(
    targets.map((cwd) => new ESLint({ cwd }).lintFiles(cwd === process.cwd() ? roots : [cwd])),
  )
).flat();

// Printed on every run, clean or not: an exit code cannot tell a full sweep from one a
// broken glob narrowed to nothing, and a caller that gates on this needs a count to floor.
const packages = targets.length === 1 ? "package" : "packages";
process.stdout.write(`code-quality-gate · ${results.length} files · ${targets.length} ${packages}\n`);

const blockingResults = results
  .map((result) => {
    const messages = result.messages.filter(
      (message) => message.severity === 2 && (allRules || BLOCKING_RULES.has(message.ruleId)),
    );
    return {
      ...result,
      messages,
      errorCount: messages.length,
      fatalErrorCount: 0,
      warningCount: 0,
      fixableErrorCount: 0,
      fixableWarningCount: 0,
    };
  })
  .filter((result) => result.messages.length > 0);

if (blockingResults.length > 0) {
  const formatter = await eslint.loadFormatter("stylish");
  process.stderr.write(formatter.format(blockingResults));
  const directives = directivesFor(
    blockingResults.flatMap((result) => result.messages.map((message) => message.ruleId)),
  );
  if (directives.length > 0) process.stderr.write(`${directives.join("\n")}\n`);
  process.exitCode = 1;
}

if (folderCheck) {
  const crowded = findCrowdedDirectories({
    roots,
    max: maxFilesPerDirectory,
    ignoredDirectories,
    extensions,
  });
  if (crowded.length > 0) {
    // One directive under the whole list: repeating it per directory would be
    // the longest part of a report that already names the same fix each time.
    const report = crowded
      .map(
        ({ directory, count }) =>
          `${path.relative(process.cwd(), directory) || "."}\n  move ${count - maxFilesPerDirectory} ` +
          `out: ${count} source files, limit ${maxFilesPerDirectory}`,
      )
      .join("\n");
    process.stderr.write(
      `\nDirectories over the file limit:\n\n${report}\n\n${CROWDED_DIRECTORY_DIRECTIVE}\n`,
    );
    process.exitCode = 1;
  }
}

if (inlineWarning) {
  const { waivers, violations } = findInlineWarningGaps({
    roots,
    all: inlineWarningAll,
  });
  const lines = [
    ...waivers.map((w) => `  waived  ${w.file}:${w.line}  ${w.component}\n      ${w.reason}`),
    ...violations.map((v) => `  ${v.file}:${v.line}  ${v.component}\n      ${v.reason}`),
  ];
  if (lines.length > 0) {
    process.stderr.write(`\nForm controls that cannot announce an error:\n\n${lines.join("\n")}\n`);
  }
  if (violations.length > 0) process.exitCode = 1;
}

/**
 * Findings from the unknown-token sweep. The themes are part of one: a name the
 * base theme declares and a rebinding forgot is absent from that theme alone.
 */
function reportUnknownTokens(options) {
  let found;
  try {
    found = findUnknownTokens(options);
  } catch (error) {
    process.stderr.write(`code-quality-gate: unknown tokens: ${error.message}\n`);
    process.exit(2);
  }
  if (found.length === 0) return;
  const where = (entry) =>
    entry.missing.filter(Boolean).length === 0 ? "" : ` in ${entry.missing.join(", ")}`;
  const report = found
    .map(
      (entry) =>
        `  ${entry.file}:${entry.line}\n      ${entry.candidate} — ` +
        `${entry.kind} ${entry.token}${where(entry)}`,
    )
    .join("\n");
  process.stderr.write(
    `\nUtilities naming a token nothing declares:\n\n${report}\n\n${UNKNOWN_TOKEN_DIRECTIVE}\n`,
  );
  process.exitCode = 1;
}

/**
 * The two checks ESLint cannot answer on its own: stylesheets, which no flat
 * config parses without a CSS language plugin, and contrast, which needs the
 * token file plus every screen at once. Both are configured in one JSON file
 * whose paths resolve against its own directory.
 */
function checkDesignTokens() {
  const here = (value) => path.resolve(settingsHome, value);
  const tokenFile = settings.tokenFile === undefined ? undefined : here(settings.tokenFile);
  const { stylesheets, sizes, typeRamp, contrast, unknownTokens } = settings;
  const counts = [];

  // Only the config's own paths resolve against the config. The roots the gate
  // was invoked with belong to the caller and stay relative to where it ran —
  // re-homing those against a config in a subdirectory points the scan at
  // directories that do not exist, and a scan of nothing reports nothing.
  const rootsFrom = (configured) =>
    configured === undefined ? roots.map((root) => path.resolve(root)) : configured.map(here);

  /**
   * A configured check that reaches no file is a broken config, not a clean run:
   * the roots or the extensions are wrong, and every finding it exists to make is
   * silently absent. Reported as a config error, because passing here is a lie.
   */
  const swept = (label, options) => {
    const files = sourceFiles(options);
    if (files.length === 0) {
      process.stderr.write(
        `code-quality-gate: ${label} matched no files under ` +
          `${options.roots.map((root) => path.relative(process.cwd(), root) || ".").join(", ")}\n`,
      );
      process.exit(2);
    }
    return files.length;
  };

  if (stylesheets) {
    const options = {
      ...stylesheets,
      roots: rootsFrom(stylesheets.roots),
      extensions: stylesheets.extensions ?? DEFAULT_STYLESHEET_EXTENSIONS,
    };
    counts.push(`${swept("stylesheets", options)} stylesheets`);
    const colors = findRawColorsInFiles({
      ...options,
      // Resolved, not as written: exemptions match by path tail, and a token
      // file named from above the config has no tail in common with itself.
      exemptFiles: [...(stylesheets.exemptFiles ?? []), ...(tokenFile ? [tokenFile] : [])],
    });
    if (colors.length > 0) {
      const report = colors
        .map((entry) => `  ${entry.file}:${entry.line}\n      ${entry.kind} "${entry.value}"`)
        .join("\n");
      process.stderr.write(`\nRaw colours in stylesheets:\n\n${report}\n`);
      process.exitCode = 1;
    }
  }

  if (sizes) {
    const options = {
      ...sizes,
      roots: rootsFrom(sizes.roots),
      extensions: sizes.extensions ?? DEFAULT_STYLESHEET_EXTENSIONS,
    };
    counts.push(`${swept("sizes", options)} stylesheets`);
    const found = findArbitrarySizesInFiles({
      ...options,
      exemptFiles: [...(sizes.exemptFiles ?? []), ...(tokenFile ? [tokenFile] : [])],
    });
    if (found.length > 0) {
      const report = found
        .map((entry) => `  ${entry.file}:${entry.line}\n      ${entry.value} — ${entry.hint}`)
        .join("\n");
      process.stderr.write(`\nArbitrary sizes in stylesheets:\n\n${report}\n`);
      process.exitCode = 1;
    }
  }

  if (typeRamp) {
    counts.push("1 type ramp");
    let gaps;
    try {
      gaps = findRampGaps({
        ...typeRamp,
        tokenFile: typeRamp.tokenFile ? here(typeRamp.tokenFile) : tokenFile,
        sources: typeRamp.sources?.map((source) => ({ ...source, file: here(source.file) })),
      });
    } catch (error) {
      process.stderr.write(`code-quality-gate: type ramp: ${error.message}\n`);
      process.exit(2);
    }
    if (gaps.length > 0) {
      const report = gaps.map((gap) => `  ${gap.token}\n      no ${gap.missing}`).join("\n");
      process.stderr.write(
        `\nType ramp steps missing a companion:\n\n${report}\n\n${TYPE_RAMP_DIRECTIVE}\n`,
      );
      process.exitCode = 1;
    }
  }

  // Every palette a section names, with its files resolved against the config.
  const homed = (sources) => sources?.map((source) => ({ ...source, file: here(source.file) }));
  const paletteFrom = (section) => ({
    ...section,
    tokenFile: section.tokenFile ? here(section.tokenFile) : tokenFile,
    sources: homed(section.sources),
    themes: section.themes?.map((theme) => ({
      ...theme,
      tokenFile: theme.tokenFile ? here(theme.tokenFile) : undefined,
      sources: homed(theme.sources),
    })),
  });

  if (unknownTokens) {
    const options = { ...paletteFrom(unknownTokens), roots: rootsFrom(unknownTokens.roots) };
    counts.push(`${swept("unknown tokens", options)} screens`);
    reportUnknownTokens(options);
  }

  if (contrast) {
    const markupRoots = rootsFrom(contrast.roots);
    if (contrast.scanMarkup !== false) {
      counts.push(`${swept("contrast", { ...contrast, roots: markupRoots })} screens`);
    }
    const palette = paletteFrom(contrast);
    let result;
    let redundant;
    try {
      result = findContrastFailures({ ...palette, roots: markupRoots });
      redundant = findRedundantOverrides(palette);
    } catch (error) {
      process.stderr.write(`code-quality-gate: contrast check: ${error.message}\n`);
      process.exit(2);
    }
    // Layering is what the themes declare, so this reads the same declaration the
    // contrast check does rather than asking the project to state it a second time.
    if (redundant.length > 0) {
      const report = redundant
        .map((entry) => `  [${entry.theme}] ${entry.token} ${entry.value} in ${entry.block}`)
        .join("\n");
      process.stderr.write(
        `\nTheme declarations that change nothing:\n\n${report}\n\n${THEME_OVERRIDE_DIRECTIVE}\n`,
      );
      process.exitCode = 1;
    }
    const named = result.themes.map((theme) => theme.name).filter(Boolean);
    counts.push(named.length > 0 ? `themes ${named.join(", ")}` : "1 theme");
    // The theme is part of the finding, not decoration: with a dark theme built
    // out of rebound tokens rather than `dark:` utilities, the same pair reads
    // two different ways and a report that omits which one is unactionable.
    const line = (entry) =>
      `  ${entry.theme ? `[${entry.theme}] ` : ""}` +
      `${entry.fg} ${entry.foreground ?? "?"} on ${entry.bg} ${entry.background ?? "?"}\n` +
      `      ${entry.reason} — ${entry.why ?? "no site recorded"}` +
      (entry.waivedBecause === undefined ? "" : `\n      allowed: ${entry.waivedBecause}`);
    if (result.waivers.length > 0) {
      process.stdout.write(
        `\nContrast failures allowed by config:\n\n${result.waivers.map(line).join("\n")}\n`,
      );
    }
    if (result.failures.length > 0) {
      process.stderr.write(`\nContrast failures:\n\n${result.failures.map(line).join("\n")}\n`);
      process.exitCode = 1;
    }
  }

  // Same reason as the file count above: a caller gating on this needs to see
  // that each configured check reached something before it trusts a clean run.
  process.stdout.write(`design tokens · ${counts.join(" · ")}\n`);
}

if (TOKEN_SECTIONS.some((section) => settings[section])) checkDesignTokens();

if (process.exitCode === 1) process.stderr.write(`\n${FIX_POLICY}\n`);
