import type { VariableType } from "@forge/contracts/variables";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

/** Each variable type as the Variables section names it. */
export const TYPE_LABEL: Record<VariableType, ProductCopyKey> = {
	plain: "settings.project.variables.type.plain",
	secret: "settings.project.variables.type.secret",
	file: "settings.project.variables.type.file",
};
