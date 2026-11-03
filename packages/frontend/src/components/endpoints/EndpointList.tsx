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
import { collectLeafEndpoints } from "./collect-leaf-endpoints.ts";
import { EndpointCard } from "./EndpointCard.tsx";
import { getEndpointName } from "./EndpointName.tsx";
import { EndpointState } from "./EndpointState.tsx";
import {
  EndpointTreeView,
  findSelectedEndpoint,
  type SortOption,
} from "./EndpointTreeView.tsx";

export interface EndpointListProps {
  endpoint: EndpointData;
  bridgeId?: string;
  onMappingSaved?: () => void;
}

export const EndpointList = (props: EndpointListProps) => {
  const { t } = useTranslation();
  // keep the id, the 10 s poll replaces the endpoint objects
  const [selectedId, setSelectedId] = useState<string | undefined>();
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

  const leaves = useMemo(
    () => collectLeafEndpoints(props.endpoint),
    [props.endpoint],
  );

  // a string key, so a poll with the same entities does not resolve again
  const entityIdsKey = useMemo(() => {
    const ids: string[] = [];
    for (const ep of leaves) {
      const state = ep.state as {
        homeAssistantEntity?: { entity?: { entity_id?: string } };
      };
      const eid = state.homeAssistantEntity?.entity?.entity_id;
      if (eid) ids.push(eid);
    }
    return ids.join(",");
  }, [leaves]);

  const refreshImages = useCallback(() => {
    if (!entityIdsKey) return;
    resolveDeviceImages(entityIdsKey.split(","))
      .then(setImageInfoMap)
      .catch(() => {});
  }, [entityIdsKey]);

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
      } catch (error) {
        // a blank dialog would overwrite the stored mapping on save
        setSnackbar({
          open: true,
          message: `${t("mapping.loadFailed")}: ${error instanceof Error ? error.message : String(error)}`,
          severity: "error",
        });
        return;
      }
      setMappingDialogOpen(true);
    },
    [t],
  );

  const handleSaveMapping = useCallback(
    async (config: Partial<EntityMappingConfig>) => {
      if (!props.bridgeId || !selectedEntityId) return;
      try {
        await updateEntityMapping(props.bridgeId, selectedEntityId, config);
        setSnackbar({
          open: true,
          message: t("mapping.saved", { entityId: selectedEntityId }),
          severity: "success",
        });
        setMappingDialogOpen(false);
        props.onMappingSaved?.();
      } catch (error) {
        setSnackbar({
          open: true,
          message: t("mapping.saveFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
          severity: "error",
        });
      }
    },
    [props.bridgeId, selectedEntityId, props.onMappingSaved, t],
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
    return leaves.filter(getEntityAvailability).length;
  }, [leaves, getEntityAvailability]);

  const endpoints = useMemo(() => {
    const filtered = leaves.filter((ep) => {
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
  }, [leaves, searchTerm, sortBy, showOnlyUnavailable, getEntityAvailability]);

  // cards hold the hoisted battery, so look there before the raw tree
  const selectedItem = useMemo(() => {
    if (!selectedId) return undefined;
    return (
      leaves.find((ep) => ep.id.global === selectedId) ??
      findSelectedEndpoint(selectedId, props.endpoint)
    );
  }, [selectedId, leaves, props.endpoint]);

  const isCards = viewMode === "cards";

  const handleCardClick = (endpoint: EndpointData) => {
    setSelectedId(endpoint.id.global);
    setDetailsOpen(true);
  };

  return (
    <Box>
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="center"
        mb={2}
        gap={2}
        flexWrap="wrap"
      >
        <Box display="flex" alignItems="center" gap={2}>
          <Typography variant="h6" component="span">
            {t("endpoints.title")} ({isCards ? endpoints.length : leaves.length}
            )
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
          display="flex"
          alignItems="center"
          justifyContent="flex-end"
          gap={1}
          flexGrow={1}
        >
          {/* the tree always shows the whole bridge, so filters are card only */}
          {isCards && (
            <TextField
              size="small"
              placeholder={t("endpoints.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              slotProps={{
                htmlInput: { "aria-label": t("endpoints.searchPlaceholder") },
              }}
              sx={{ flexGrow: 1, maxWidth: 300 }}
            />
          )}

          {isCards && unavailableCount > 0 && (
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
                    ? t("endpoints.showAll")
                    : t("endpoints.showUnavailable", {
                        count: unavailableCount,
                      })
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
              <Box display="flex" alignItems="center" gap={0.5}>
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
            aria-label={t("endpoints.viewMode")}
          >
            <ToggleButton value="cards" aria-label={t("endpoints.cardView")}>
              <Tooltip title={t("endpoints.cardView")}>
                <GridViewIcon />
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="tree" aria-label={t("endpoints.treeView")}>
              <Tooltip title={t("endpoints.treeView")}>
                <ListIcon />
              </Tooltip>
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </Box>

      {isCards && endpoints.length === 0 && (
        <Typography color="text.secondary">
          {t("endpoints.noEndpoints")}
        </Typography>
      )}

      {isCards ? (
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
              onSelected={(ep) => setSelectedId(ep?.id.global)}
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
