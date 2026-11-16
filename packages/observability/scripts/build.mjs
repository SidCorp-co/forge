// The observability build: emit into a staging directory and publish it into dist file by file, the
// same step as the contracts build (`packages/contracts/scripts/publish-dist.mjs`), so a reader
// importing @forge/observability while it rebuilds reads each module whole, old or new.

import { fileURLToPath } from "node:url";
import { emitAndPublish } from "../../contracts/scripts/publish-dist.mjs";

const pkg = fileURLToPath(new URL("..", import.meta.url));
process.exit(emitAndPublish(pkg, ["-p", "tsconfig.json"]));
