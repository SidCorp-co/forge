import { Banner, Button, Property, PropertyList } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useState } from "react";
import { useRotateIntegrationSecret } from "../../hooks";
import { embedSnippet, IDENTIFY_SNIPPET, SIGNING_SNIPPET } from "./config";

/** The web's own base address, where the loader is served beside the app (WEB_V2_BASE_PATH included). */
export function webBase(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).href;
}

function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  function copy(what: string, text: string) {
    setFailed(false);
    if (!navigator.clipboard) {
      setFailed(true);
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => setCopied(what),
      () => setFailed(true),
    );
  }
  return { copied, failed, copy };
}

function Snippet({ id, text, copied, onCopy }: { id: string; text: string; copied: boolean; onCopy: () => void }) {
  const t = useCopy();
  return (
    <div className="flex flex-col gap-1.5">
      <pre className="fg-code overflow-x-auto whitespace-pre rounded-md border border-line bg-sunken p-3" data-testid={`widget-snippet-${id}`}>
        {text}
      </pre>
      <Button className="self-start" size="sm" variant="secondary" icon={copied ? "check" : "link"} onClick={onCopy}>
        {copied ? t("integrations.widget.copied") : t("integrations.widget.copy")}
      </Button>
    </div>
  );
}

/** The script tag a client page embeds, with this binding's site key, ready to copy. */
export function EmbedCode({ siteKey }: { siteKey: string }) {
  const t = useCopy();
  const { copied, failed, copy } = useCopied();
  const tag = embedSnippet(siteKey, webBase());
  return (
    <div className="flex flex-col gap-2" data-testid="widget-embed">
      <span className="fg-label">{t("integrations.widget.embed")}</span>
      <PropertyList>
        <Property label={t("integrations.widget.siteKey")}>
          <span className="break-all font-mono" translate="no">
            {siteKey}
          </span>
        </Property>
      </PropertyList>
      <Snippet id="embed" text={tag} copied={copied === "embed"} onCopy={() => copy("embed", tag)} />
      {failed && <p className="fg-caption text-danger">{t("integrations.widget.copyFailed")}</p>}
    </div>
  );
}

/**
 * Signed mode's secret: minted by core and shown once, on generating or rotating it, beside how the
 * client's backend signs `${userId}.${ts}` with it and how its page hands the signature over.
 */
export function SigningSecret({ projectId, bindingId }: { projectId: string; bindingId: string }) {
  const t = useCopy();
  const rotate = useRotateIntegrationSecret(projectId);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { copied, failed, copy } = useCopied();

  async function mint() {
    setError(null);
    try {
      setSecret((await rotate.mutateAsync(bindingId)).integrationSecret);
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3" data-testid="widget-signing">
      <span className="fg-label">{t("integrations.widget.secret")}</span>
      {secret ? (
        <>
          <Banner tone="attention">{t("integrations.widget.copyNow")}</Banner>
          <Snippet id="secret" text={secret} copied={copied === "secret"} onCopy={() => copy("secret", secret)} />
        </>
      ) : (
        <p className="fg-body-sm text-muted">{t("integrations.widget.secretHidden")}</p>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
      <Button className="self-start" variant="secondary" onClick={() => void mint()} loading={rotate.isPending}>
        {t("integrations.widget.rotate")}
      </Button>
      <span className="fg-label">{t("integrations.widget.signOnServer")}</span>
      <Snippet id="sign" text={SIGNING_SNIPPET} copied={copied === "sign"} onCopy={() => copy("sign", SIGNING_SNIPPET)} />
      <span className="fg-label">{t("integrations.widget.identifyOnPage")}</span>
      <Snippet id="identify" text={IDENTIFY_SNIPPET} copied={copied === "identify"} onCopy={() => copy("identify", IDENTIFY_SNIPPET)} />
      {failed && <p className="fg-caption text-danger">{t("integrations.widget.copyFailed")}</p>}
    </div>
  );
}
