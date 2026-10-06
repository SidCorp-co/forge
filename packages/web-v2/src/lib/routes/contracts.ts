export const contractsHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/contracts`;

export const contractHref = (slug: string, ref: string) => {
  const cut = ref.indexOf("/");
  return `${contractsHref(slug)}/${encodeURIComponent(ref.slice(0, cut))}/${encodeURIComponent(ref.slice(cut + 1))}`;
};

export const CONTRACTS_LIST = "contracts";
