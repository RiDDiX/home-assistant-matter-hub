import { useEffect, useMemo, useRef, useState } from "react";
import packageJson from "../../../../apps/home-assistant-matter-hub/package.json";
import { useWebSocketStatus } from "../contexts/WebSocketContext.tsx";

export interface AppInfo {
  name: string;
  version: string;
  frontendVersion: string;
  backendVersion: string | null;
  versionMismatch: boolean;
}

export function useAppInfo(): AppInfo {
  const frontendVersion = __APP_VERSION__;
  const [backendVersion, setBackendVersion] = useState<string | null>(null);
  const { isConnected } = useWebSocketStatus();
  const fetched = useRef(false);

  // on mount, then after every reconnect since the backend may have been updated
  useEffect(() => {
    if (fetched.current && !isConnected) return;
    fetched.current = true;
    fetch("api/health")
      // 503 means unhealthy but still carries the version
      .then((res) => (res.ok || res.status === 503 ? res.json() : null))
      .then((data) => {
        if (data?.version) {
          setBackendVersion(data.version);
        }
      })
      .catch(() => {});
  }, [isConnected]);

  const versionMismatch = useMemo(() => {
    if (!backendVersion || frontendVersion === "0.0.0-dev") return false;
    return frontendVersion !== backendVersion;
  }, [backendVersion]);

  return useMemo(
    () => ({
      name: packageJson.name,
      version: backendVersion ?? frontendVersion,
      frontendVersion,
      backendVersion,
      versionMismatch,
    }),
    [backendVersion, versionMismatch],
  );
}
