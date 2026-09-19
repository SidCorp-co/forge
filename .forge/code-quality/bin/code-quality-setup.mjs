#!/usr/bin/env node

// Every mechanical step of adopting this plugin in one project: the dependency, the flat config,
// the settings file, the lint script. Severities are arguments — the only part left to decide.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLINT_CONFIG_FILES, RULE_NAMES, SETTINGS_FILE, TOKEN_SECTIONS } from "../src/index.js";

const SEVERITIES = new Set(["error", "warn", "off"]);
/** The `=`-flags that are not a rule, so one pass can reject a typo in either kind. */
const OPTIONS = new Set(["tokens", "primitives", "hook"]);
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const USAGE = `Usage: code-quality-setup [options]

  --<rule>=error|warn|off   one per rule, default error (design rules: off)
  --tokens=FILE             the CSS file colours and sizes belong in
  --primitives=DIR          the design system product code may not reach past
  --hook=on|off             lint each file Claude Code edits (default on)
  --all-rules               gate on the project's own error rules too
  --dry-run                 print every file and command, write nothing
  --help                    show this message

Rules: ${RULE_NAMES.join(", ")}
`;

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const dryRun = args.includes("--dry-run");
const steps = [];

/** Probed once: a parser dependency and a parserless config would be one bug written twice. */
const typescript = existsSync("tsconfig.json") || existsSync("tsconfig.base.json");

function fail(message) {
  process.stderr.write(`code-quality-setup: ${message}\n`);
  process.exit(2);
}

function flag(name) {
  const found = args.find((argument) => argument.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(found.indexOf("=") + 1);
}

/**
 * The severities, in one pass over the arguments so that a typo in a rule name and a typo in
 * a severity are both refused before anything is written.
 */
function severities() {
  const chosen = {};
  for (const argument of args) {
    if (!argument.startsWith("--") || !argument.includes("=")) continue;
    const split = argument.indexOf("=");
    const name = argument.slice(2, split);
    const value = argument.slice(split + 1);
    if (OPTIONS.has(name)) continue;
    if (!RULE_NAMES.includes(name)) fail(`no rule named ${name}`);
    if (!SEVERITIES.has(value)) fail(`--${name}= takes error, warn or off, not "${value}"`);
    chosen[name] = value;
  }
  return chosen;
}

/** The lockfile decides, because a second package manager in one project splits the tree. */
function packageManager() {
  if (existsSync("pnpm-lock.yaml")) {
    // pnpm has no global link, and `file:` copies into the store — a snapshot no later
    // edit of the checkout ever reaches.
    const workspace = existsSync("pnpm-workspace.yaml");
    return { add: ["pnpm", "add", "-D", ...(workspace ? ["-w"] : [])], spec: "link:" };
  }
  if (existsSync("yarn.lock")) return { add: ["yarn", "add", "-D"], spec: "file:" };
  if (existsSync("bun.lockb")) return { add: ["bun", "add", "-d"], spec: "file:" };
  return { add: ["npm", "install", "--save-dev"], spec: "file:" };
}

function run(command) {
  steps.push(`$ ${command.join(" ")}`);
  if (dryRun) return;
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) fail(`\`${command.join(" ")}\` failed`);
}

function write(file, contents) {
  steps.push(`${dryRun ? "would write" : "wrote"} ${file}`);
  if (!dryRun) writeFileSync(file, contents);
}

/**
 * A parser is only wanted for a config this run writes: a project holding one has answered the
 * question, and better, since TypeScript 7 breaks `@typescript-eslint/parser` at module load.
 */
function dependencies(manager, writesConfig) {
  const wanted = ["eslint", ...(typescript && writesConfig ? ["@typescript-eslint/parser"] : [])];
  const declared = JSON.parse(readFileSync("package.json", "utf8"));
  const installed = { ...declared.dependencies, ...declared.devDependencies };
  const missing = wanted.filter((name) => installed[name] === undefined);
  const relative = path.relative(process.cwd(), packageRoot).split(path.sep).join("/");
  if (installed["eslint-plugin-code-quality"] === undefined) {
    missing.push(`${manager.spec}${relative}`);
  }
  return missing;
}

function renderCall(chosen, nouns, indent) {
  const { tokens, primitives } = nouns;
  const lines = Object.entries(chosen).map(
    ([rule, severity]) => `${indent}  "${rule}": "${severity}",`,
  );
  if (tokens !== undefined) lines.push(`${indent}  tokens: { tokenSource: "${tokens}" },`);
  if (primitives !== undefined) {
    lines.push(`${indent}  primitives: { source: "${primitives}" },`);
  }
  if (lines.length === 0) return "configure()";
  return `configure({\n${lines.join("\n")}\n${indent}})`;
}

function configFile(chosen, nouns) {
  return `${typescript ? 'import tsParser from "@typescript-eslint/parser";\n' : ""}\
import { configure } from "eslint-plugin-code-quality";

export default [
${typescript ? '  { files: ["**/*.{ts,tsx,mts,cts}"], languageOptions: { parser: tsParser } },\n' : ""}\
  ...${renderCall(chosen, nouns, "  ")},
];
`;
}

/** The paren closing the call opened at `start`, or -1 for an unbalanced file. */
function callEnd(source, start) {
  let depth = 0;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

/**
 * `renderCall` writes one severity per rule and a `tokens` source. A call holding anything richer
 * says more than the answers do, so replacing it wholesale would delete the difference silently.
 */
function rendersEverythingIn(call) {
  const body = call.slice(call.indexOf("(") + 1, call.lastIndexOf(")"));
  return !/\[|ignores|testGlobs|exemptFiles/.test(body);
}

/**
 * The answers replace the call they were last written into and nothing else, so a project that has
 * since added parsers or rules of its own keeps them. A config assembling this plugin some other
 * way is reported rather than guessed at: only the call is ours.
 */
function rewriteCall(file, chosen, nouns) {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf("configure(");
  if (start === -1) return "holds no configure() call";
  const end = callEnd(source, start);
  if (end === -1) return "holds an unbalanced configure() call";
  if (!rendersEverythingIn(source.slice(start, end + 1))) {
    return "holds a configure() call saying more than these answers do";
  }

  // The line's own indent, not the column of the call — `...configure(` sits past its own.
  const [indent] = source.slice(source.lastIndexOf("\n", start) + 1, start).match(/^\s*/);
  steps.push(`${dryRun ? "would rewrite" : "rewrote"} the configure() call in ${file}`);
  if (dryRun) return null;

  writeFileSync(file, source.slice(0, start) + renderCall(chosen, nouns, indent) + source.slice(end + 1));
  // A paren scan cannot know one inside a string from the one closing the call, so the parse is
  // the check, and the file it was read from is the way back.
  if (spawnSync(process.execPath, ["--check", file]).status === 0) return null;
  writeFileSync(file, source);
  steps.pop();
  return "holds a configure() call this run could not rewrite";
}

/**
 * The gate's half of the answers, and the hook's one opt-out. The answers are authoritative —
 * every run asks for all of them — so `hook` and `allRules` are set from this run rather than
 * merged, while anything else the project tuned in here is left as it is.
 */
function settingsFile(tokens, hook, allRules) {
  const existing = existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) : {};
  const settings = { ...existing };
  const record = (key, value, when) => {
    if (when) settings[key] = value;
    else delete settings[key];
  };
  record("hook", false, !hook);
  record("allRules", true, allRules);
  if (tokens !== undefined) {
    settings.tokenFile = tokens;
    for (const section of TOKEN_SECTIONS) settings[section] ??= {};
  }
  return settings;
}

function addLintScript() {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const scripts = manifest.scripts ?? {};
  if (Object.values(scripts).some((script) => script.includes("code-quality-gate"))) {
    steps.push("package.json already runs the gate");
    return;
  }
  manifest.scripts = { ...scripts, "lint:code-quality": "code-quality-gate" };
  write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

if (!existsSync("package.json")) fail("no package.json here");
const chosen = severities();
const tokens = flag("tokens");
if (tokens !== undefined && !existsSync(tokens)) fail(`--tokens=${tokens} does not exist`);
const primitives = flag("primitives");
if (primitives !== undefined && !existsSync(primitives)) {
  fail(`--primitives=${primitives} does not exist`);
}
const nouns = { tokens, primitives };
const hook = (flag("hook") ?? "on") === "on";

const existingConfig = ESLINT_CONFIG_FILES.find((file) => existsSync(file));

const manager = packageManager();
const missing = dependencies(manager, existingConfig === undefined);
if (missing.length > 0) run([...manager.add, ...missing]);

const unrewritable =
  existingConfig === undefined ? null : rewriteCall(existingConfig, chosen, nouns);
if (existingConfig === undefined) write("eslint.config.mjs", configFile(chosen, nouns));
else if (unrewritable !== null) {
  steps.push(`${existingConfig} ${unrewritable} — merge these answers into it by hand:`);
  for (const line of `...${renderCall(chosen, nouns, "")},`.split("\n")) steps.push(`    ${line}`);
}

// A project with nothing to settle needs no file, but one that had keys and no longer does needs
// them gone: an answer of "on" cannot leave last run's opt-out behind.
const settings = settingsFile(tokens, hook, args.includes("--all-rules"));
if (existsSync(SETTINGS_FILE) || Object.keys(settings).length > 0) {
  write(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}
addLintScript();

process.stdout.write(`${steps.map((step) => `  ${step}`).join("\n")}\n`);
if (dryRun) process.exit(0);

// A config that reaches nothing also exits 0, so the sweep's own counts are the report.
const gate = spawnSync(process.execPath, [path.join(packageRoot, "bin", "code-quality-gate.mjs")], {
  stdio: "inherit",
});
process.exitCode = gate.status === 0 ? 0 : 1;
