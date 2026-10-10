
import { Button } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { bounceCause, clearBounce, goToLogin } from "../login-bounce";
import { AuthShell } from "./auth-shell";

/**
 * What a page shows instead of a second redirect to /login (login-bounce.ts): the cause, and one
 * way out that is the person's own act. It never navigates by itself.
 */
export function SignInStopped() {
  const t = useCopy();
  const framed = bounceCause() === "frame-cookies";
  const again = () => {
    clearBounce();
    goToLogin();
  };
  return (
    <AuthShell
      title={framed ? t("auth.stopped.framedTitle") : t("auth.stopped.title")}
      subtitle={framed ? t("auth.stopped.framed") : t("auth.stopped.sessionLost")}
    >
      <p className="fg-body-sm mb-4">{framed ? t("auth.stopped.framedAct") : t("auth.stopped.sessionLostAct")}</p>
      <Button onClick={again}>{t("auth.stopped.signIn")}</Button>
    </AuthShell>
  );
}
