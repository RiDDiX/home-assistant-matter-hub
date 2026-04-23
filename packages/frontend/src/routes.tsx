import type { RouteObject } from "react-router";
import { AppPage } from "./pages/AppPage.tsx";
import { AreaBridgeSetupPage } from "./pages/area-setup/AreaBridgeSetupPage.tsx";
import { BridgeDetailsPage } from "./pages/bridge-details/BridgeDetailsPage.tsx";
import { BridgesPage } from "./pages/bridges/BridgesPage.tsx";
import { DashboardPage } from "./pages/dashboard/DashboardPage.tsx";
import { DevicesPage } from "./pages/devices/DevicesPage.tsx";
import { CreateBridgePage } from "./pages/edit-bridge/CreateBridgePage.tsx";
import { EditBridgePage } from "./pages/edit-bridge/EditBridgePage.tsx";
import { HealthPage } from "./pages/health/HealthPage.tsx";
import { LabelsPage } from "./pages/labels/LabelsPage.tsx";
import { LockCredentialsPage } from "./pages/lock-credentials/LockCredentialsPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { NetworkMapPage } from "./pages/network-map/NetworkMapPage.tsx";
import { PluginsPage } from "./pages/plugins/PluginsPage.tsx";
import { SettingsPage } from "./pages/settings/SettingsPage.tsx";
import StandaloneDevicesPage from "./pages/standalone-devices/StandaloneDevicesPage.tsx";
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
  networkMap: "/network-map",
  standaloneDevices: "/standalone-devices",
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
      { path: navigation.createBridge, element: <CreateBridgePage /> },
      { path: navigation.areaSetup, element: <AreaBridgeSetupPage /> },
      { path: navigation.bridge(":bridgeId"), element: <BridgeDetailsPage /> },
      { path: navigation.editBridge(":bridgeId"), element: <EditBridgePage /> },
      { path: navigation.devices, element: <DevicesPage /> },
      { path: navigation.networkMap, element: <NetworkMapPage /> },
      { path: navigation.health, element: <HealthPage /> },
      {
        path: navigation.standaloneDevices,
        element: <StandaloneDevicesPage />,
      },
      { path: navigation.labels, element: <LabelsPage /> },
      { path: navigation.lockCredentials, element: <LockCredentialsPage /> },
      { path: navigation.plugins, element: <PluginsPage /> },
      { path: navigation.settings, element: <SettingsPage /> },
      { path: navigation.startup, element: <StartupPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
