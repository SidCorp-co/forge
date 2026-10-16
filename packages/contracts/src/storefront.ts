// The codes the storefront target read refuses under.

export const STOREFRONT_REFUSAL_CODES = [
	"STOREFRONT_REFUSED",
	"STOREFRONT_PROVIDER_UNKNOWN",
	"STOREFRONT_PROVIDER_AMBIGUOUS",
	"STOREFRONT_LABEL_UNKNOWN",
] as const;

export type StorefrontRefusalCode = (typeof STOREFRONT_REFUSAL_CODES)[number];
