"use client";

import { PrivateKeysScreen } from "@/features/resources/components/private-keys-screen";
import { useActiveOrg } from "@/features/orgs/active-org";

/** `/resources` — workspace Resources area, scoped to the active org (ISS-628). */
export default function ResourcesPage() {
  const { activeOrgId } = useActiveOrg();
  return <PrivateKeysScreen orgId={activeOrgId} />;
}
