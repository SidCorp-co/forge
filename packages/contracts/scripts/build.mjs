// The contracts build: emit into a staging directory, then publish it into dist file by file
// (`publish-dist.mjs`), so dist is never absent while it runs. Then every export must resolve to an
// emitted file (`check-exports.mjs`).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emitAndPublish } from "./publish-dist.mjs";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const emitted = emitAndPublish(pkg, ["-p", "tsconfig.emit.json", "--noCheck"]);
if (emitted !== 0) process.exit(emitted);
process.exit(
	spawnSync("node", ["scripts/check-exports.mjs"], {
		cwd: pkg,
		stdio: "inherit",
	}).status ?? 1,
);
