import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth-store";

export function useLogout() {
  const navigate = useNavigate();
  return async () => {
    await useAuthStore.getState().logout();
    navigate("/login", { replace: true });
  };
}
