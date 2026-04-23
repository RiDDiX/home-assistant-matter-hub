import type {
  BridgeDataWithMetadata,
  EndpointData,
} from "@home-assistant-matter-hub/common";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import UndoIcon from "@mui/icons-material/Undo";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import { useColorScheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getEndpointName } from "../../components/endpoints/EndpointName.tsx";
import { BridgeNode } from "../../components/network-map/nodes/BridgeNode.tsx";
import { DeviceNode } from "../../components/network-map/nodes/DeviceNode.tsx";
import { FabricNode } from "../../components/network-map/nodes/FabricNode.tsx";
import { FailedNode } from "../../components/network-map/nodes/FailedNode.tsx";
import { HubNode } from "../../components/network-map/nodes/HubNode.tsx";
import { useBridges } from "../../hooks/data/bridges.ts";
import { loadBridges } from "../../state/bridges/bridge-actions.ts";
import { loadDevices } from "../../state/devices/device-actions.ts";
import { useAppDispatch, useAppSelector } from "../../state/hooks.ts";

const nodeTypes = {
  hub: HubNode,
  bridge: BridgeNode,
  device: DeviceNode,
  fabric: FabricNode,
  failed: FailedNode,
};

function collectLeafEndpoints(endpoint: EndpointData): EndpointData[] {
  if (!endpoint.parts || endpoint.parts.length === 0) {
    if (endpoint.endpoint !== 0) {
      return [endpoint];
    }
    return [];
  }
  return endpoint.parts.flatMap(collectLeafEndpoints);
}

interface LayoutConfig {
  hubX: number;
  minBridgeSpacingY: number;
  deviceSpacingY: number;
  devicesPerColumn: number;
  deviceColumnSpacingX: number;
  fabricOffsetX: number;
  bridgeOffsetX: number;
  deviceOffsetX: number;
}

interface EdgeColors {
  running: string;
  inactive: string;
  device: string;
  failed: string;
  fabric: string;
}

function buildGraph(
  bridges: BridgeDataWithMetadata[],
  devicesByBridge: Record<string, EndpointData | undefined>,
  layout: LayoutConfig,
  colors: EdgeColors,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const totalDevices = bridges.reduce((sum, b) => sum + b.deviceCount, 0);

  // Track unique fabrics across bridges (deduplicate by vendorId)
  const fabricMap = new Map<
    number,
    { vendorId: number; label: string; bridgeIds: string[] }
  >();

  // Pre-calculate per-bridge section heights for dynamic vertical positioning
  const bridgeSections = bridges.map((bridge) => {
    const rootEndpoint = devicesByBridge[bridge.id];
    const devices = rootEndpoint ? collectLeafEndpoints(rootEndpoint) : [];
    const failedCount = bridge.failedEntities?.length ?? 0;
    const totalItems = devices.length + failedCount;
    const rows = Math.min(totalItems, layout.devicesPerColumn);
    const height = Math.max(
      layout.minBridgeSpacingY,
      rows * layout.deviceSpacingY + 80,
    );
    return { bridge, devices, height };
  });

  const totalHeight = bridgeSections.reduce((sum, s) => sum + s.height, 0);
  const hubY = totalHeight / 2;

  // Hub node (centered vertically across all bridge sections)
  nodes.push({
    id: "hub",
    type: "hub",
    position: { x: layout.hubX, y: hubY - 60 },
    data: {
      label: "HAMH",
      bridgeCount: bridges.length,
      deviceCount: totalDevices,
    },
  });

  let currentY = 0;

  bridgeSections.forEach(({ bridge, devices, height }) => {
    const bridgeId = `bridge-${bridge.id}`;
    const bridgeCenterY = currentY + height / 2;
    const bridgeX = layout.hubX + layout.bridgeOffsetX;

    const fabricCount = bridge.commissioning?.fabrics?.length ?? 0;
    const failedCount = bridge.failedEntities?.length ?? 0;

    nodes.push({
      id: bridgeId,
      type: "bridge",
      position: { x: bridgeX, y: bridgeCenterY - 30 },
      data: {
        label: bridge.name,
        status: bridge.status,
        port: bridge.port,
        deviceCount: bridge.deviceCount,
        failedCount,
        fabricCount,
      },
    });

    edges.push({
      id: `hub-${bridgeId}`,
      source: "hub",
      target: bridgeId,
      type: "smoothstep",
      animated: bridge.status === "running",
      style: {
        stroke: bridge.status === "running" ? colors.running : colors.inactive,
        strokeWidth: 2,
      },
    });

    // Collect fabrics
    if (bridge.commissioning?.fabrics) {
      for (const fabric of bridge.commissioning.fabrics) {
        const existing = fabricMap.get(fabric.rootVendorId);
        if (existing) {
          if (!existing.bridgeIds.includes(bridge.id)) {
            existing.bridgeIds.push(bridge.id);
          }
        } else {
          fabricMap.set(fabric.rootVendorId, {
            vendorId: fabric.rootVendorId,
            label: fabric.label,
            bridgeIds: [bridge.id],
          });
        }
      }
    }

    // Devices + failed entities in grid layout (multiple columns)
    const failedEntities = bridge.failedEntities ?? [];
    const totalItems = devices.length + failedEntities.length;
    const rows = Math.min(totalItems, layout.devicesPerColumn);
    const gridHeight = rows * layout.deviceSpacingY;
    const deviceStartY = bridgeCenterY - gridHeight / 2;
    const deviceX = bridgeX + layout.deviceOffsetX;

    devices.forEach((device, i) => {
      const col = Math.floor(i / layout.devicesPerColumn);
      const row = i % layout.devicesPerColumn;
      const deviceId = `device-${bridge.id}-${device.id.global}`;
      const name = getEndpointName(device.state) ?? device.id.local;

      nodes.push({
        id: deviceId,
        type: "device",
        position: {
          x: deviceX + col * layout.deviceColumnSpacingX,
          y: deviceStartY + row * layout.deviceSpacingY,
        },
        data: {
          label: name,
          deviceType: device.type.name,
          entityId: device.id.local,
        },
      });

      edges.push({
        id: `${bridgeId}-${deviceId}`,
        source: bridgeId,
        target: deviceId,
        type: "smoothstep",
        style: { stroke: colors.device, strokeWidth: 1 },
      });
    });

    // Failed entities continue in the same grid after devices
    failedEntities.forEach((failed, fi) => {
      const overallIndex = devices.length + fi;
      const col = Math.floor(overallIndex / layout.devicesPerColumn);
      const row = overallIndex % layout.devicesPerColumn;
      const failedId = `failed-${bridge.id}-${failed.entityId}`;

      nodes.push({
        id: failedId,
        type: "failed",
        position: {
          x: deviceX + col * layout.deviceColumnSpacingX,
          y: deviceStartY + row * layout.deviceSpacingY,
        },
        data: {
          label: failed.entityId,
          reason: failed.reason,
        },
      });

      edges.push({
        id: `${bridgeId}-${failedId}`,
        source: bridgeId,
        target: failedId,
        type: "smoothstep",
        style: {
          stroke: colors.failed,
          strokeWidth: 1,
          strokeDasharray: "5,5",
        },
      });
    });

    currentY += height;
  });

  // Fabric / controller nodes (left side)
  const fabricEntries = Array.from(fabricMap.values());
  const fabricSpacingY = 120;
  const totalFabricHeight = (fabricEntries.length - 1) * fabricSpacingY;
  const fabricStartY = hubY - totalFabricHeight / 2;

  fabricEntries.forEach((fabric, fabricIndex) => {
    const fabricId = `fabric-${fabric.vendorId}`;

    nodes.push({
      id: fabricId,
      type: "fabric",
      position: {
        x: layout.hubX + layout.fabricOffsetX,
        y: fabricStartY + fabricIndex * fabricSpacingY,
      },
      data: {
        label: fabric.label,
        vendorId: fabric.vendorId,
      },
    });

    // Connect fabric to each bridge it's commissioned on
    for (const bridgeIdRaw of fabric.bridgeIds) {
      edges.push({
        id: `${fabricId}-bridge-${bridgeIdRaw}`,
        source: fabricId,
        target: `bridge-${bridgeIdRaw}`,
        type: "smoothstep",
        animated: true,
        style: { stroke: colors.fabric, strokeWidth: 1.5 },
      });
    }
  });

  return { nodes, edges };
}

export const NetworkMapPage = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { content: bridges, isLoading: bridgesLoading } = useBridges();
  const allDeviceStates = useAppSelector((state) => state.devices.byBridge);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const undoStackRef = useRef<
    { nodeId: string; position: { x: number; y: number } }[]
  >([]);
  const [canUndo, setCanUndo] = useState(false);

  useEffect(() => {
    dispatch(loadBridges());
  }, [dispatch]);

  useEffect(() => {
    if (bridges) {
      for (const bridge of bridges) {
        dispatch(loadDevices(bridge.id));
      }
    }
  }, [dispatch, bridges]);

  const devicesByBridge = useMemo(() => {
    const result: Record<string, EndpointData | undefined> = {};
    if (bridges) {
      for (const bridge of bridges) {
        result[bridge.id] = allDeviceStates[bridge.id]?.content;
      }
    }
    return result;
  }, [bridges, allDeviceStates]);

  const devicesLoaded = useMemo(() => {
    if (!bridges || bridges.length === 0) return true;
    return bridges.every((b) => allDeviceStates[b.id]?.isInitialized);
  }, [bridges, allDeviceStates]);

  useEffect(() => {
    if (!bridges || !devicesLoaded) return;

    const layout: LayoutConfig = {
      hubX: 400,
      minBridgeSpacingY: 200,
      deviceSpacingY: 55,
      devicesPerColumn: 10,
      deviceColumnSpacingX: 220,
      fabricOffsetX: -350,
      bridgeOffsetX: 250,
      deviceOffsetX: 280,
    };

    const edgeColors: EdgeColors = {
      running: isDark ? "#81c784" : "#4caf50",
      inactive: isDark ? "#616161" : "#bdbdbd",
      device: isDark ? "#90caf9" : "#64b5f6",
      failed: isDark ? "#ef5350" : "#f44336",
      fabric: isDark ? "#ce93d8" : "#ab47bc",
    };

    const graph = buildGraph(bridges, devicesByBridge, layout, edgeColors);

    // Restore saved positions from localStorage
    const STORAGE_KEY = "hamh-network-map-positions";
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const positions = JSON.parse(saved) as Record<
          string,
          { x: number; y: number }
        >;
        for (const node of graph.nodes) {
          if (positions[node.id]) {
            node.position = positions[node.id];
          }
        }
      }
    } catch {
      /* ignore corrupt data */
    }

    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [bridges, devicesByBridge, devicesLoaded, setNodes, setEdges, isDark]);

  const handleRefresh = useCallback(() => {
    dispatch(loadBridges());
  }, [dispatch]);

  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      // Save the previous position for undo before persisting
      const prev = nodes.find((n) => n.id === node.id);
      if (prev) {
        undoStackRef.current.push({
          nodeId: node.id,
          position: { ...prev.position },
        });
        setCanUndo(true);
      }

      // Persist all current positions to localStorage
      const STORAGE_KEY = "hamh-network-map-positions";
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        const positions: Record<string, { x: number; y: number }> = saved
          ? JSON.parse(saved)
          : {};
        positions[node.id] = { x: node.position.x, y: node.position.y };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
      } catch {
        /* ignore */
      }
    },
    [nodes],
  );

  const handleResetLayout = useCallback(() => {
    localStorage.removeItem("hamh-network-map-positions");
    undoStackRef.current = [];
    setCanUndo(false);
    // Re-trigger graph build by reloading bridges
    dispatch(loadBridges());
  }, [dispatch]);

  const handleUndo = useCallback(() => {
    const last = undoStackRef.current.pop();
    if (!last) return;
    setCanUndo(undoStackRef.current.length > 0);

    setNodes((nds) =>
      nds.map((n) =>
        n.id === last.nodeId ? { ...n, position: last.position } : n,
      ),
    );

    // Update localStorage
    const STORAGE_KEY = "hamh-network-map-positions";
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const positions: Record<string, { x: number; y: number }> = saved
        ? JSON.parse(saved)
        : {};
      positions[last.nodeId] = last.position;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
    } catch {
      /* ignore */
    }
  }, [setNodes]);

  const isLoading = bridgesLoading || !devicesLoaded;

  return (
    <Box sx={{ p: 2 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 2,
        }}
      >
        <Typography
          variant="h4"
          sx={{ display: "flex", alignItems: "center", gap: 2 }}
        >
          <AccountTreeIcon />
          {t("networkMap.title")}
        </Typography>
        <Box sx={{ display: "flex", gap: 0.5 }}>
          <Tooltip title={t("networkMap.undoMove")}>
            <span>
              <IconButton
                onClick={handleUndo}
                color="primary"
                disabled={!canUndo}
              >
                <UndoIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t("networkMap.resetLayout")}>
            <IconButton onClick={handleResetLayout} color="primary">
              <RestartAltIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("networkMap.refreshData")}>
            <IconButton onClick={handleRefresh} color="primary">
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <Tooltip
            title={
              isFullscreen
                ? t("networkMap.exitFullscreen")
                : t("networkMap.fullscreen")
            }
          >
            <IconButton
              onClick={() => setIsFullscreen((f) => !f)}
              color="primary"
            >
              {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {isLoading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 8 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Box
          sx={{
            width: "100%",
            height: isFullscreen ? "calc(100vh - 100px)" : 600,
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 2,
            overflow: "hidden",
            transition: "height 0.3s ease",
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes}
            colorMode={isDark ? "dark" : "light"}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls />
            <MiniMap
              nodeStrokeWidth={3}
              zoomable
              pannable
              nodeColor={(node) => {
                switch (node.type) {
                  case "hub":
                    return "#1976d2";
                  case "bridge":
                    return "#4caf50";
                  case "fabric":
                    return "#9c27b0";
                  case "failed":
                    return "#f44336";
                  default:
                    return isDark ? "#90caf9" : "#90a4ae";
                }
              }}
              style={{ borderRadius: 8 }}
            />
          </ReactFlow>
        </Box>
      )}

      {/* Legend */}
      <Box
        sx={{
          display: "flex",
          gap: 3,
          mt: 2,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontWeight: 600 }}
        >
          {t("networkMap.legend")}:
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #7b1fa2, #9c27b0)",
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {t("networkMap.controller")}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #1976d2, #1565c0)",
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {t("networkMap.hub")}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: 0.5,
              background: isDark ? "#1b3a1b" : "#e8f5e9",
              border: "1px solid #4caf50",
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {t("networkMap.bridge")}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: 0.5,
              background: isDark ? "#2a2a2a" : "#fff",
              border: `1px solid ${isDark ? "#616161" : "#bdbdbd"}`,
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {t("networkMap.device")}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: 0.5,
              background: isDark ? "#3a1515" : "#ffebee",
              border: "1px dashed #f44336",
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {t("networkMap.failed")}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};
