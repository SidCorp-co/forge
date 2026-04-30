import { useNavigate } from "react-router-dom";
import { clearAuthState } from "@/lib/clear-auth";

export function useLogout() {
  const navigate = useNavigate();
  return async () => {
    await clearAuthState({ unregisterDesktop: true });
    navigate("/login", { replace: true });
  };
}
