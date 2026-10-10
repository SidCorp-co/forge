// The one web-v2 lint rule no published plugin carries: a feature component named after a layout
// word (*Row, *Section, *Card, *Panel, *Facts) is a copy of a shared block in @/design. A name is
// allowed only with an entry in ui-grammar-allowlist.json saying why it is not such a copy.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), "ui-grammar-allowlist.json");
const allowed = JSON.parse(readFileSync(ALLOW_PATH, "utf8"));
const LAYOUT_NAME = /^[A-Z][A-Za-z0-9]*(Row|Section|Card|Panel|Facts)$/;

const noLayoutName = {
  meta: {
    type: "suggestion",
    docs: { description: "A feature component is named for what it shows, never for a layout word (CODE-STANDARD.md, Components)." },
    schema: [],
    messages: {
      layoutName:
        "`{{name}}` is named for a layout word. Use the shared block from @/design (src/design/README.md), or name it for what it shows. A name that is not such a copy needs an entry in eslint/ui-grammar-allowlist.json with its reason.",
    },
  },
  create(context) {
    const check = (id) => {
      if (!id || id.type !== "Identifier" || !LAYOUT_NAME.test(id.name)) return;
      if (typeof allowed[id.name] === "string" && allowed[id.name].trim()) return;
      context.report({ node: id, messageId: "layoutName", data: { name: id.name } });
    };
    const isComponentInit = (init) =>
      init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression" || (init.type === "CallExpression" && /^(memo|forwardRef)$/.test(init.callee.name ?? init.callee.property?.name ?? "")));
    return {
      "Program > FunctionDeclaration, Program > ExportNamedDeclaration > FunctionDeclaration, Program > ExportDefaultDeclaration > FunctionDeclaration"(node) {
        check(node.id);
      },
      "Program > VariableDeclaration > VariableDeclarator, Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator"(node) {
        if (isComponentInit(node.init)) check(node.id);
      },
    };
  },
};

export default { meta: { name: "ui-grammar" }, rules: { "no-layout-name": noLayoutName } };
