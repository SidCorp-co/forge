// The contracts build: emit into a staging directory, then publish it into dist file by file
// (`publish-dist.mjs`), so dist is never absent while it runs. Then every export must resolve to an
// emitted file (`check-exports.mjs`).

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publish, stagingDir } from "./publish-dist.mjs";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const dist = join(pkg, "dist");
const run = (argv) =>
	spawnSync(argv[0], argv.slice(1), { cwd: pkg, stdio: "inherit" }).status;

const staged = stagingDir(dist);
const emitted = run([
	"tsgo",
	"-p",
	"tsconfig.emit.json",
	"--noCheck",
	"--outDir",
	staged,
]);
if (emitted !== 0) {
	rmSync(staged, { recursive: true, force: true });
	process.exit(emitted ?? 1);
}
publish(staged, dist);
process.exit(run(["node", "scripts/check-exports.mjs"]) ?? 1);
