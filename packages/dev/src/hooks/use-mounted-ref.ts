import { useEffect, useRef } from "react";

export function useMountedRef() {
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);
  return mountedRef;
}
