import { useRef } from "react";

// a disabled button stops a second submit only once `isPending` has re-rendered, and a second submit landing before that render posted a second record (ISS-35 and ISS-36 from one submit); the ref is read and set synchronously, so the second submit is refused in the same tick as the first
export function useSubmitGuard() {
  const heldRef = useRef(false);
  return {
    claim: (): boolean => {
      if (heldRef.current) return false;
      heldRef.current = true;
      return true;
    },
    release: (): void => {
      heldRef.current = false;
    },
  };
}
