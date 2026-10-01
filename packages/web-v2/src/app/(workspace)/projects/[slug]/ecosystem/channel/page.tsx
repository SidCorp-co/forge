"use client";

// The channel register (`/projects/[slug]/ecosystem/channel`), filtered by `?status=` and
// scoped by `?ecosystem=`; built by `ecosystemRoutes.register`.
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";
import { writes } from "@/features/ecosystem/components/document-actions";
import { RegisterScreen } from "@/features/ecosystem/components/register-screen";
import { ecosystemRoutes } from "@/features/ecosystem/routes";

function Register() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(search?.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  };
  return (
    <EcosystemPage
      slug={params?.slug}
      section="channel"
      title="Channel register"
      actions={(p) =>
        writes(p.role) ? (
          <Link
            href={ecosystemRoutes.compose(p.slug, { ecosystem: search?.get("ecosystem") ?? undefined })}
            className="inline-flex items-center rounded-md bg-accent px-[11px] py-[6px] text-13 text-on-accent"
          >
            New document
          </Link>
        ) : null
      }
    >
      {(project) => (
        <RegisterScreen
          projectId={project.id}
          slug={project.slug}
          rawFilter={search?.get("status") ?? null}
          rawEcosystem={search?.get("ecosystem") ?? null}
          onFilter={(f) => setParam("status", f === "all" ? null : f)}
          onEcosystem={(id) => setParam("ecosystem", id)}
        />
      )}
    </EcosystemPage>
  );
}

export default function ChannelRegisterPage() {
  return (
    <Suspense fallback={null}>
      <Register />
    </Suspense>
  );
}
