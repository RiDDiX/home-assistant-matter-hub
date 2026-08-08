import { useEffect, useMemo, useState } from "react";
import packageJson from "../../../../apps/home-assistant-matter-hub/package.json";

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

  useEffect(() => {
    fetch("api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.version) {
          setBackendVersion(data.version);
        }
      })
      .catch(() => {});
  }, []);

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
