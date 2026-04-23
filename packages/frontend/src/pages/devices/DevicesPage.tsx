import type {
  EndpointData,
  EntityMappingConfig,
  FailedEntity,
} from "@home-assistant-matter-hub/common";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CloseIcon from "@mui/icons-material/Close";
import DevicesIcon from "@mui/icons-material/Devices";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningIcon from "@mui/icons-material/Warning";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Pagination from "@mui/material/Pagination";
import Select from "@mui/material/Select";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import type { DeviceImageInfo } from "../../api/device-images";
import { resolveDeviceImages } from "../../api/device-images";
import {
  fetchEntityMappings,
  updateEntityMapping,
} from "../../api/entity-mappings";
import { EndpointCard } from "../../components/endpoints/EndpointCard";
import { getEndpointName } from "../../components/endpoints/EndpointName";
import { EntityMappingDialog } from "../../components/entity-mapping/EntityMappingDialog";
import { useBridges } from "../../hooks/data/bridges";
import { loadBridges } from "../../state/bridges/bridge-actions";
import { loadDevices } from "../../state/devices/device-actions";
import { useAppDispatch, useAppSelector } from "../../state/hooks";

interface DeviceInfo {
  bridgeId: string;
  bridgeName: string;
  endpoint: EndpointData;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const PAGE_SIZE_KEY = "hamh-devices-page-size";

interface FailedEntityInfo extends FailedEntity {
  bridgeName: string;
}

export const DevicesPage = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { content: bridges, isLoading: bridgesLoading } = useBridges();
  const [searchParams, setSearchParams] = useSearchParams();
  const showFailed = searchParams.get("showFailed") === "true";
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedBridge, setSelectedBridge] = useState<string>("");
  const [selectedType, setSelectedType] = useState<string>("");
  const [sortBy, setSortBy] = useState<"name" | "type" | "bridge">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [itemsPerPage, setItemsPerPageRaw] = useState<number>(() => {
    const stored = localStorage.getItem(PAGE_SIZE_KEY);
    if (!stored) return 12;
    if (stored === "all") return 0;
    const num = parseInt(stored, 10);
    return num > 0 ? num : 12;
  });
  const [customPageSize, setCustomPageSize] = useState("");

  const setItemsPerPage = useCallback((size: number) => {
    setItemsPerPageRaw(size);
    localStorage.setItem(PAGE_SIZE_KEY, size === 0 ? "all" : String(size));
    setPage(1);
  }, []);

  // Entity Mapping Dialog state
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [selectedEntityId, setSelectedEntityId] = useState<string>("");
  const [selectedMappingBridgeId, setSelectedMappingBridgeId] =
    useState<string>("");
  const [currentMapping, setCurrentMapping] = useState<
    EntityMappingConfig | undefined
  >();
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({ open: false, message: "", severity: "success" });

  // Load bridges on mount
  useEffect(() => {
    dispatch(loadBridges());
  }, [dispatch]);

  // Load devices for each bridge
  useEffect(() => {
    if (bridges) {
      bridges.forEach((bridge) => {
        dispatch(loadDevices(bridge.id));
      });
    }
  }, [dispatch, bridges]);

  // Get all device states from Redux
  const allDeviceStates = useAppSelector((state) => state.devices.byBridge);

  // Recursively collect all leaf endpoints (actual devices, not aggregators)
  const collectDeviceEndpoints = useCallback(
    (
      endpoint: EndpointData,
      bridgeId: string,
      bridgeName: string,
    ): DeviceInfo[] => {
      const results: DeviceInfo[] = [];

      // If this endpoint has no children, it's a leaf device
      if (!endpoint.parts || endpoint.parts.length === 0) {
        // Skip the root node itself (usually has endpoint number 0)
        if (endpoint.endpoint !== 0) {
          results.push({ bridgeId, bridgeName, endpoint });
        }
      } else {
        // Recursively collect from children
        for (const child of endpoint.parts) {
          results.push(...collectDeviceEndpoints(child, bridgeId, bridgeName));
        }
      }

      return results;
    },
    [],
  );

  // Extract all endpoints from all bridges
  const devices = useMemo(() => {
    const allDevices: DeviceInfo[] = [];

    (bridges || []).forEach((bridge) => {
      const deviceState = allDeviceStates[bridge.id];
      const rootEndpoint = deviceState?.content;

      if (rootEndpoint) {
        allDevices.push(
          ...collectDeviceEndpoints(rootEndpoint, bridge.id, bridge.name),
        );
      }
    });

    return allDevices;
  }, [bridges, allDeviceStates, collectDeviceEndpoints]);

  // Device image state
  const [imageInfoMap, setImageInfoMap] = useState<
    Record<string, DeviceImageInfo>
  >({});

  const allEntityIds = useMemo(() => {
    const ids: string[] = [];
    for (const d of devices) {
      const state = d.endpoint.state as {
        homeAssistantEntity?: { entity?: { entity_id?: string } };
      };
      const eid = state.homeAssistantEntity?.entity?.entity_id;
      if (eid) ids.push(eid);
    }
    return ids;
  }, [devices]);

  const refreshImages = useCallback(() => {
    if (allEntityIds.length === 0) return;
    resolveDeviceImages(allEntityIds)
      .then(setImageInfoMap)
      .catch(() => {});
  }, [allEntityIds]);

  useEffect(() => {
    refreshImages();
  }, [refreshImages]);

  const handleImageChanged = useCallback(() => {
    refreshImages();
  }, [refreshImages]);

  const isLoading =
    bridgesLoading || (bridges && bridges.length > 0 && devices.length === 0);

  // Collect failed entities from all bridges
  const failedEntities = useMemo<FailedEntityInfo[]>(() => {
    if (!bridges) return [];
    const result: FailedEntityInfo[] = [];
    for (const bridge of bridges) {
      for (const fe of bridge.failedEntities ?? []) {
        result.push({ ...fe, bridgeName: bridge.name });
      }
    }
    return result;
  }, [bridges]);

  const dismissFailed = useCallback(() => {
    setSearchParams((prev) => {
      prev.delete("showFailed");
      return prev;
    });
  }, [setSearchParams]);

  // Filter devices
  const filteredDevices = useMemo(() => {
    return devices.filter((device) => {
      const deviceName =
        getEndpointName(device.endpoint.state) ?? device.endpoint.id.local;
      const deviceType = device.endpoint.type.name;

      const matchesSearch =
        deviceName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        device.bridgeName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        deviceType.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesBridge =
        !selectedBridge || device.bridgeId === selectedBridge;
      const matchesType = !selectedType || deviceType === selectedType;

      return matchesSearch && matchesBridge && matchesType;
    });
  }, [devices, searchTerm, selectedBridge, selectedType]);

  // Sort devices
  const sortedDevices = useMemo(() => {
    const sorted = [...filteredDevices].sort((a, b) => {
      const nameA = getEndpointName(a.endpoint.state) ?? a.endpoint.id.local;
      const nameB = getEndpointName(b.endpoint.state) ?? b.endpoint.id.local;

      let comparison = 0;
      switch (sortBy) {
        case "name":
          comparison = nameA.localeCompare(nameB);
          break;
        case "type":
          comparison = a.endpoint.type.name.localeCompare(b.endpoint.type.name);
          // Secondary sort by name within same type
          if (comparison === 0) {
            comparison = nameA.localeCompare(nameB);
          }
          break;
        case "bridge":
          comparison = a.bridgeName.localeCompare(b.bridgeName);
          // Secondary sort by name within same bridge
          if (comparison === 0) {
            comparison = nameA.localeCompare(nameB);
          }
          break;
      }
      return sortDirection === "asc" ? comparison : -comparison;
    });
    return sorted;
  }, [filteredDevices, sortBy, sortDirection]);

  // Pagination
  const totalPages =
    itemsPerPage === 0 ? 1 : Math.ceil(sortedDevices.length / itemsPerPage);
  const paginatedDevices =
    itemsPerPage === 0
      ? sortedDevices
      : sortedDevices.slice((page - 1) * itemsPerPage, page * itemsPerPage);

  // Get unique device types (always sorted alphabetically)
  const deviceTypes = useMemo(() => {
    const types = new Set(devices.map((d) => d.endpoint.type.name));
    return Array.from(types).sort();
  }, [devices]);

  // Sort bridges alphabetically based on current sort direction
  const sortedBridges = useMemo(() => {
    if (!bridges) return [];
    return [...bridges].sort((a, b) => {
      const comparison = a.name.localeCompare(b.name);
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [bridges, sortDirection]);

  const handleRefresh = useCallback(() => {
    dispatch(loadBridges());
  }, [dispatch]);

  const handleEditMapping = useCallback(
    async (entityId: string, bridgeId: string) => {
      setSelectedEntityId(entityId);
      setSelectedMappingBridgeId(bridgeId);
      try {
        const mappings = await fetchEntityMappings(bridgeId);
        const existingMapping = mappings.mappings.find(
          (m) => m.entityId === entityId,
        );
        setCurrentMapping(existingMapping);
      } catch {
        setCurrentMapping(undefined);
      }
      setMappingDialogOpen(true);
    },
    [],
  );

  const handleSaveMapping = useCallback(
    async (config: Partial<EntityMappingConfig>) => {
      if (!selectedMappingBridgeId || !selectedEntityId) return;
      try {
        await updateEntityMapping(
          selectedMappingBridgeId,
          selectedEntityId,
          config,
        );
        setSnackbar({
          open: true,
          message: t("mapping.saved", { entityId: selectedEntityId }),
          severity: "success",
        });
        setMappingDialogOpen(false);
      } catch (error) {
        setSnackbar({
          open: true,
          message: t("mapping.saveFailed", { error: String(error) }),
          severity: "error",
        });
      }
    },
    [selectedMappingBridgeId, selectedEntityId, t],
  );

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2 }}>
      <Typography
        variant="h4"
        gutterBottom
        sx={{ display: "flex", alignItems: "center", gap: 2 }}
      >
        <DevicesIcon />
        {t("nav.devices")}
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={handleRefresh}
          sx={{ ml: "auto" }}
        >
          {t("common.refresh")}
        </Button>
      </Typography>

      {showFailed && failedEntities.length > 0 && (
        <Alert
          severity="warning"
          sx={{ mb: 3 }}
          action={
            <IconButton size="small" color="inherit" onClick={dismissFailed}>
              <CloseIcon fontSize="small" />
            </IconButton>
          }
        >
          <Typography variant="body2" sx={{ fontWeight: "bold" }} gutterBottom>
            {t("devices.failedEntitiesTitle", {
              count: failedEntities.length,
              defaultValue: `${failedEntities.length} failed entities`,
            })}
          </Typography>
          <List dense disablePadding>
            {failedEntities.map((fe) => (
              <ListItem key={`${fe.bridgeName}-${fe.entityId}`} sx={{ py: 0 }}>
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <WarningIcon color="warning" fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={<span style={{ fontSize: 14 }}>{fe.entityId}</span>}
                  secondary={
                    <span
                      style={{ fontSize: 12, color: "#888" }}
                    >{`${fe.bridgeName} — ${fe.reason}`}</span>
                  }
                />
              </ListItem>
            ))}
          </List>
        </Alert>
      )}

      {showFailed && failedEntities.length === 0 && (
        <Alert
          severity="success"
          sx={{ mb: 3 }}
          action={
            <IconButton size="small" color="inherit" onClick={dismissFailed}>
              <CloseIcon fontSize="small" />
            </IconButton>
          }
        >
          <Typography variant="body2">
            {t("devices.noFailedEntities", {
              defaultValue:
                "No failed entities — all devices loaded successfully.",
            })}
          </Typography>
        </Alert>
      )}

      {/* Filters */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Stack
            direction="row"
            spacing={1.5}
            sx={{ mb: 2, flexWrap: "wrap" }}
            useFlexGap
          >
            <TextField
              label={t("devices.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              sx={{ flexGrow: 1 }}
            />

            <FormControl sx={{ minWidth: 200 }}>
              <InputLabel>{t("devices.filterBridge")}</InputLabel>
              <Select
                value={selectedBridge}
                label={t("devices.filterBridge")}
                onChange={(e) => setSelectedBridge(e.target.value)}
              >
                <MenuItem value="">{t("devices.allBridges")}</MenuItem>
                {sortedBridges.map((bridge) => (
                  <MenuItem key={bridge.id} value={bridge.id}>
                    {bridge.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl sx={{ minWidth: 200 }}>
              <InputLabel>{t("devices.filterDeviceType")}</InputLabel>
              <Select
                value={selectedType}
                label={t("devices.filterDeviceType")}
                onChange={(e) => setSelectedType(e.target.value)}
              >
                <MenuItem value="">{t("devices.allTypes")}</MenuItem>
                {deviceTypes.map((type) => (
                  <MenuItem key={type} value={type}>
                    {type}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl sx={{ minWidth: 150 }}>
              <InputLabel>{t("devices.sortBy")}</InputLabel>
              <Select
                value={sortBy}
                label={t("devices.sortBy")}
                onChange={(e) =>
                  setSortBy(e.target.value as "name" | "type" | "bridge")
                }
              >
                <MenuItem value="bridge">{t("devices.sortBridge")}</MenuItem>
                <MenuItem value="type">{t("devices.sortType")}</MenuItem>
                <MenuItem value="name">{t("devices.sortName")}</MenuItem>
              </Select>
            </FormControl>

            <Tooltip
              title={
                sortDirection === "asc"
                  ? t("common.ascending")
                  : t("common.descending")
              }
            >
              <IconButton
                onClick={() =>
                  setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"))
                }
                color="primary"
              >
                {sortDirection === "asc" ? (
                  <ArrowUpwardIcon />
                ) : (
                  <ArrowDownwardIcon />
                )}
              </IconButton>
            </Tooltip>
          </Stack>
        </CardContent>
      </Card>

      {/* Device Grid */}
      <Grid container spacing={2}>
        {paginatedDevices.map((device) => (
          <Grid
            key={`${device.bridgeId}-${device.endpoint.id.global}`}
            size={{ xs: 12, sm: 6, lg: 4 }}
          >
            <EndpointCard
              endpoint={device.endpoint}
              bridgeName={device.bridgeName}
              bridgeId={device.bridgeId}
              onEditMapping={handleEditMapping}
              imageInfo={
                imageInfoMap[
                  (
                    device.endpoint.state as {
                      homeAssistantEntity?: { entity?: { entity_id?: string } };
                    }
                  ).homeAssistantEntity?.entity?.entity_id ?? ""
                ]
              }
              onImageChanged={handleImageChanged}
            />
          </Grid>
        ))}
      </Grid>

      {/* Pagination & Page Size */}
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          mt: 3,
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ whiteSpace: "nowrap" }}
          >
            Per page:
          </Typography>
          <Select
            value={
              itemsPerPage === 0
                ? "all"
                : PAGE_SIZE_OPTIONS.includes(itemsPerPage)
                  ? String(itemsPerPage)
                  : ""
            }
            onChange={(e) => {
              const val = e.target.value;
              setCustomPageSize("");
              if (val === "all") {
                setItemsPerPage(0);
              } else {
                setItemsPerPage(parseInt(val, 10));
              }
            }}
            displayEmpty
            renderValue={(value) => {
              if (value === "all") return t("common.all");
              if (value === "") return String(itemsPerPage);
              return value;
            }}
            size="small"
            sx={{ minWidth: 80 }}
          >
            {PAGE_SIZE_OPTIONS.map((opt) => (
              <MenuItem key={opt} value={String(opt)}>
                {opt}
              </MenuItem>
            ))}
            <MenuItem value="all">{t("common.all")}</MenuItem>
          </Select>
          <TextField
            size="small"
            type="number"
            placeholder={t("common.custom")}
            value={customPageSize}
            onChange={(e) => setCustomPageSize(e.target.value)}
            onBlur={() => {
              const num = parseInt(customPageSize, 10);
              if (num > 0) {
                setItemsPerPage(num);
              }
              setCustomPageSize("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const num = parseInt(customPageSize, 10);
                if (num > 0) {
                  setItemsPerPage(num);
                }
                setCustomPageSize("");
              }
            }}
            slotProps={{
              htmlInput: { min: 1, style: { textAlign: "center" } },
            }}
            sx={{ width: 80 }}
          />
        </Stack>

        {totalPages > 1 && (
          <Pagination
            count={totalPages}
            page={page}
            onChange={(_, newPage) => setPage(newPage)}
            color="primary"
          />
        )}

        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ whiteSpace: "nowrap" }}
        >
          {filteredDevices.length === devices.length
            ? t("devices.deviceCount", { count: devices.length })
            : t("devices.filteredCount", {
                filtered: filteredDevices.length,
                total: devices.length,
              })}
        </Typography>
      </Box>

      {filteredDevices.length === 0 && (
        <Box sx={{ textAlign: "center", py: 8 }}>
          <Typography variant="h6" color="text.secondary">
            No devices found
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Try adjusting your filters or check if any bridges are running
          </Typography>
        </Box>
      )}

      {/* Entity Mapping Dialog */}
      <EntityMappingDialog
        open={mappingDialogOpen}
        entityId={selectedEntityId}
        domain={selectedEntityId.split(".")[0] || ""}
        currentMapping={currentMapping}
        onSave={handleSaveMapping}
        onClose={() => setMappingDialogOpen(false)}
      />

      {/* Snackbar for feedback */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
      >
        <Alert
          onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
          severity={snackbar.severity}
          sx={{ width: "100%" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};
