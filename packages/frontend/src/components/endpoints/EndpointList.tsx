import type {
  EndpointData,
  EntityMappingConfig,
} from "@home-assistant-matter-hub/common";
import DevicesIcon from "@mui/icons-material/Devices";
import GridViewIcon from "@mui/icons-material/GridView";
import ListIcon from "@mui/icons-material/List";
import SortIcon from "@mui/icons-material/Sort";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Alert from "@mui/material/Alert";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Snackbar from "@mui/material/Snackbar";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { DeviceImageInfo } from "../../api/device-images";
import { resolveDeviceImages } from "../../api/device-images";
import {
  fetchEntityMappings,
  updateEntityMapping,
} from "../../api/entity-mappings";
import { navigation } from "../../routes.tsx";
import { EntityMappingDialog } from "../entity-mapping/EntityMappingDialog.tsx";
import { EndpointCard } from "./EndpointCard.tsx";
import { getEndpointName } from "./EndpointName.tsx";
import { EndpointState } from "./EndpointState.tsx";
import { EndpointTreeView, type SortOption } from "./EndpointTreeView.tsx";

export interface EndpointListProps {
  endpoint: EndpointData;
  bridgeId?: string;
  onMappingSaved?: () => void;
}

const collectLeafEndpoints = (endpoint: EndpointData): EndpointData[] => {
  const parts = endpoint.parts ?? [];
  if (parts.length === 0) {
    return [endpoint];
  }
  return parts.flatMap((part) => collectLeafEndpoints(part));
};

export const EndpointList = (props: EndpointListProps) => {
  const { t } = useTranslation();
  const [selectedItem, setSelectedItem] = useState<EndpointData | undefined>(
    undefined,
  );
  const [sortBy, setSortBy] = useState<SortOption>("name");
  const [viewMode, setViewMode] = useState<"cards" | "tree">("cards");
  const [searchTerm, setSearchTerm] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showOnlyUnavailable, setShowOnlyUnavailable] = useState(false);

  // Entity Mapping state
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [selectedEntityId, setSelectedEntityId] = useState<string>("");
  const [currentMapping, setCurrentMapping] = useState<
    EntityMappingConfig | undefined
  >();
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({ open: false, message: "", severity: "success" });

  // Device image state
  const [imageInfoMap, setImageInfoMap] = useState<
    Record<string, DeviceImageInfo>
  >({});

  const allEntityIds = useMemo(() => {
    const leaves = collectLeafEndpoints(props.endpoint);
    const ids: string[] = [];
    for (const ep of leaves) {
      const state = ep.state as {
        homeAssistantEntity?: { entity?: { entity_id?: string } };
      };
      const eid = state.homeAssistantEntity?.entity?.entity_id;
      if (eid) ids.push(eid);
    }
    return ids;
  }, [props.endpoint]);

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

  const handleEditMapping = useCallback(
    async (entityId: string, bridgeId: string) => {
      if (!bridgeId) return;
      setSelectedEntityId(entityId);
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
      if (!props.bridgeId || !selectedEntityId) return;
      try {
        await updateEntityMapping(props.bridgeId, selectedEntityId, config);
        setSnackbar({
          open: true,
          message: `Mapping saved for ${selectedEntityId}. Restart the bridge to apply changes.`,
          severity: "success",
        });
        setMappingDialogOpen(false);
        props.onMappingSaved?.();
      } catch (error) {
        setSnackbar({
          open: true,
          message: `Failed to save mapping: ${error}`,
          severity: "error",
        });
      }
    },
    [props.bridgeId, selectedEntityId, props.onMappingSaved],
  );

  const getEntityAvailability = useCallback((ep: EndpointData) => {
    const state = ep.state as {
      homeAssistantEntity?: {
        entity?: { state?: { state?: string } };
      };
    };
    const haState = state.homeAssistantEntity?.entity?.state?.state;
    return haState === "unavailable" || haState === "unknown";
  }, []);

  const unavailableCount = useMemo(() => {
    return collectLeafEndpoints(props.endpoint).filter(getEntityAvailability)
      .length;
  }, [props.endpoint, getEntityAvailability]);

  const endpoints = useMemo(() => {
    const leafEndpoints = collectLeafEndpoints(props.endpoint);

    const filtered = leafEndpoints.filter((ep) => {
      if (showOnlyUnavailable && !getEntityAvailability(ep)) {
        return false;
      }
      const name = getEndpointName(ep.state) ?? ep.id.local;
      const type = ep.type.name;
      const search = searchTerm.toLowerCase();
      return (
        name.toLowerCase().includes(search) ||
        type.toLowerCase().includes(search)
      );
    });

    return [...filtered].sort((a, b) => {
      const nameA = getEndpointName(a.state) ?? a.id.local;
      const nameB = getEndpointName(b.state) ?? b.id.local;

      switch (sortBy) {
        case "name":
          return nameA.localeCompare(nameB);
        case "endpoint":
          return a.id.local.localeCompare(b.id.local);
        case "type":
          return a.type.name.localeCompare(b.type.name);
        default:
          return 0;
      }
    });
  }, [
    props.endpoint,
    searchTerm,
    sortBy,
    showOnlyUnavailable,
    getEntityAvailability,
  ]);

  const handleCardClick = (endpoint: EndpointData) => {
    setSelectedItem(endpoint);
    setDetailsOpen(true);
  };

  return (
    <Box>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 2,
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Typography variant="h6" component="span">
            {t("endpoints.title")} ({endpoints.length})
          </Typography>
          <Tooltip title={t("endpoints.viewAll")}>
            <IconButton
              component={Link}
              to={navigation.devices}
              size="small"
              color="primary"
            >
              <DevicesIcon />
            </IconButton>
          </Tooltip>
        </Box>

        <Box
          sx={{ display: "flex", alignItems: "center", gap: 1, flexGrow: 1 }}
        >
          <TextField
            size="small"
            placeholder={t("endpoints.searchPlaceholder")}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            sx={{ flexGrow: 1, maxWidth: 300 }}
          />

          {unavailableCount > 0 && (
            <Tooltip
              title={
                showOnlyUnavailable
                  ? t("endpoints.showAll")
                  : t("endpoints.showUnavailable", { count: unavailableCount })
              }
            >
              <IconButton
                size="small"
                color={showOnlyUnavailable ? "warning" : "default"}
                onClick={() => setShowOnlyUnavailable((v) => !v)}
                aria-label={
                  showOnlyUnavailable
                    ? "Show all entities"
                    : `Show ${unavailableCount} unavailable entities`
                }
              >
                <Badge badgeContent={unavailableCount} color="warning" max={99}>
                  <WarningAmberIcon />
                </Badge>
              </IconButton>
            </Tooltip>
          )}

          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel id="sort-label">
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                <SortIcon fontSize="small" /> {t("endpoints.sortBy")}
              </Box>
            </InputLabel>
            <Select
              labelId="sort-label"
              value={sortBy}
              label={t("endpoints.sortBy")}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
            >
              <MenuItem value="name">{t("endpoints.sortName")}</MenuItem>
              <MenuItem value="endpoint">
                {t("endpoints.sortEndpoint")}
              </MenuItem>
              <MenuItem value="type">{t("endpoints.sortType")}</MenuItem>
            </Select>
          </FormControl>

          <ToggleButtonGroup
            value={viewMode}
            exclusive
            onChange={(_, value) => value && setViewMode(value)}
            size="small"
            aria-label="View mode"
          >
            <ToggleButton value="cards" aria-label="Card view">
              <Tooltip title={t("endpoints.cardView")}>
                <GridViewIcon />
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="tree" aria-label="Tree view">
              <Tooltip title={t("endpoints.treeView")}>
                <ListIcon />
              </Tooltip>
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </Box>

      {viewMode === "cards" ? (
        <Grid container spacing={2}>
          {endpoints.map((ep) => (
            <Grid key={ep.id.global} size={{ xs: 12, sm: 6, lg: 4 }}>
              <EndpointCard
                endpoint={ep}
                bridgeId={props.bridgeId}
                onClick={() => handleCardClick(ep)}
                onEditMapping={props.bridgeId ? handleEditMapping : undefined}
                imageInfo={
                  imageInfoMap[
                    (
                      ep.state as {
                        homeAssistantEntity?: {
                          entity?: { entity_id?: string };
                        };
                      }
                    ).homeAssistantEntity?.entity?.entity_id ?? ""
                  ]
                }
                onImageChanged={handleImageChanged}
              />
            </Grid>
          ))}
        </Grid>
      ) : (
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 4 }}>
            <EndpointTreeView
              endpoint={props.endpoint}
              onSelected={setSelectedItem}
              sortBy={sortBy}
            />
          </Grid>
          <Grid size={{ xs: 12, md: 8 }}>
            {selectedItem && <EndpointState endpoint={selectedItem} />}
          </Grid>
        </Grid>
      )}

      <Dialog
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {selectedItem &&
            (getEndpointName(selectedItem.state) ?? selectedItem.id.local)}
        </DialogTitle>
        <DialogContent>
          {selectedItem && <EndpointState endpoint={selectedItem} />}
        </DialogContent>
      </Dialog>

      {props.bridgeId && (
        <EntityMappingDialog
          open={mappingDialogOpen}
          onClose={() => setMappingDialogOpen(false)}
          entityId={selectedEntityId}
          domain={selectedEntityId.split(".")[0] || ""}
          currentMapping={currentMapping}
          onSave={handleSaveMapping}
        />
      )}

      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
      >
        <Alert
          onClose={() => setSnackbar({ ...snackbar, open: false })}
          severity={snackbar.severity}
          sx={{ width: "100%" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};
