import { Navigate, type RouteObject } from "react-router";
import { AppPage } from "./pages/AppPage.tsx";
import { BridgeDetailsPage } from "./pages/bridge-details/BridgeDetailsPage.tsx";
import { BridgesPage } from "./pages/bridges/BridgesPage.tsx";
import { CreateBridgePage } from "./pages/edit-bridge/CreateBridgePage.tsx";
import { EditBridgePage } from "./pages/edit-bridge/EditBridgePage.tsx";
import { HealthPage } from "./pages/health/HealthPage.tsx";

const documentationUrl = "https://riddix.github.io/home-assistant-matter-hub";
export const navigation = {
  bridges: "/bridges",
  bridge: (bridgeId: string) => `/bridges/${bridgeId}`,
  createBridge: "/bridges/create",
  editBridge: (bridgeId: string) => `/bridges/${bridgeId}/edit`,
  health: "/health",

  githubRepository: "https://github.com/riddix/home-assistant-matter-hub/",
  documentation: documentationUrl,
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
        element: <Navigate to={navigation.bridges} replace={true} />,
      },
      { path: navigation.bridges, element: <BridgesPage /> },
      { path: navigation.createBridge, element: <CreateBridgePage /> },
      { path: navigation.bridge(":bridgeId"), element: <BridgeDetailsPage /> },
      { path: navigation.editBridge(":bridgeId"), element: <EditBridgePage /> },
      { path: navigation.health, element: <HealthPage /> },
    ],
  },
];
