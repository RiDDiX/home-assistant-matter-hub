import type { RouteObject } from "react-router";
import { AppPage } from "./pages/AppPage.tsx";
import { BridgeDetailsPage } from "./pages/bridge-details/BridgeDetailsPage.tsx";
import { BridgesPage } from "./pages/bridges/BridgesPage.tsx";
import { DashboardPage } from "./pages/dashboard/DashboardPage.tsx";
import { DevicesPage } from "./pages/devices/DevicesPage.tsx";
import { HealthPage } from "./pages/health/HealthPage.tsx";
import { LabelsPage } from "./pages/labels/LabelsPage.tsx";
import { LockCredentialsPage } from "./pages/lock-credentials/LockCredentialsPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { StandaloneDevicesPage } from "./pages/standalone-devices/StandaloneDevicesPage.tsx";
import { StartupPage } from "./pages/startup/StartupPage.tsx";

const documentationUrl = "https://riddix.github.io/home-assistant-matter-hub";
export const navigation = {
  dashboard: "/",
  bridges: "/bridges",
  bridge: (bridgeId: string) => `/bridges/${bridgeId}`,
  createBridge: "/bridges/create",
  areaSetup: "/bridges/area-setup",
  editBridge: (bridgeId: string) => `/bridges/${bridgeId}/edit`,
  devices: "/devices",
  standaloneDevices: "/standalone-devices",
  networkMap: "/network-map",
  health: "/health",
  labels: "/labels",
  lockCredentials: "/lock-credentials",
  plugins: "/plugins",
  settings: "/settings",
  startup: "/startup",

  githubRepository: "https://github.com/riddix/home-assistant-matter-hub/",
  documentation: documentationUrl,
  support: `${documentationUrl}/support`,
  faq: {
    multiFabric: `${documentationUrl}/connect-multiple-fabrics`,
    bridgeConfig: `${documentationUrl}/bridge-configuration`,
  },
};

export const routes: RouteObject[] = [
  {
    path: "",
    element: <AppPage />,
    children: [
      {
        path: "",
        element: <DashboardPage />,
      },
      { path: navigation.bridges, element: <BridgesPage /> },
      {
        path: navigation.createBridge,
        lazy: async () => ({
          Component: (await import("./pages/edit-bridge/CreateBridgePage.tsx"))
            .CreateBridgePage,
        }),
      },
      {
        path: navigation.areaSetup,
        lazy: async () => ({
          Component: (
            await import("./pages/area-setup/AreaBridgeSetupPage.tsx")
          ).AreaBridgeSetupPage,
        }),
      },
      { path: navigation.bridge(":bridgeId"), element: <BridgeDetailsPage /> },
      {
        path: navigation.editBridge(":bridgeId"),
        lazy: async () => ({
          Component: (await import("./pages/edit-bridge/EditBridgePage.tsx"))
            .EditBridgePage,
        }),
      },
      { path: navigation.devices, element: <DevicesPage /> },
      {
        path: navigation.standaloneDevices,
        element: <StandaloneDevicesPage />,
      },
      {
        path: navigation.networkMap,
        lazy: async () => ({
          Component: (await import("./pages/network-map/NetworkMapPage.tsx"))
            .NetworkMapPage,
        }),
      },
      { path: navigation.health, element: <HealthPage /> },
      { path: navigation.labels, element: <LabelsPage /> },
      { path: navigation.lockCredentials, element: <LockCredentialsPage /> },
      {
        path: navigation.plugins,
        lazy: async () => ({
          Component: (await import("./pages/plugins/PluginsPage.tsx"))
            .PluginsPage,
        }),
      },
      {
        path: navigation.settings,
        lazy: async () => ({
          Component: (await import("./pages/settings/SettingsPage.tsx"))
            .SettingsPage,
        }),
      },
      { path: navigation.startup, element: <StartupPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
