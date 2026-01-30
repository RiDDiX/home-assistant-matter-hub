import type {
  EndpointData,
  EntityMappingConfig,
} from "@home-assistant-matter-hub/common";
import DevicesIcon from "@mui/icons-material/Devices";
import GridViewIcon from "@mui/icons-material/GridView";
import ListIcon from "@mui/icons-material/List";
import SortIcon from "@mui/icons-material/Sort";
import Alert from "@mui/material/Alert";
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
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
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
  const [selectedItem, setSelectedItem] = useState<EndpointData | undefined>(
    undefined,
  );
  const [sortBy, setSortBy] = useState<SortOption>("name");
  const [viewMode, setViewMode] = useState<"cards" | "tree">("cards");
  const [searchTerm, setSearchTerm] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);

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

  const endpoints = useMemo(() => {
    const leafEndpoints = collectLeafEndpoints(props.endpoint);

    const filtered = leafEndpoints.filter((ep) => {
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
  }, [props.endpoint, searchTerm, sortBy]);

  const handleCardClick = (endpoint: EndpointData) => {
    setSelectedItem(endpoint);
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
            Endpoints ({endpoints.length})
          </Typography>
          <Tooltip title="View All Devices">
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

        <Box display="flex" alignItems="center" gap={1} flexGrow={1}>
          <TextField
            size="small"
            placeholder="Search endpoints..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            sx={{ flexGrow: 1, maxWidth: 300 }}
          />

          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel id="sort-label">
              <Box display="flex" alignItems="center" gap={0.5}>
                <SortIcon fontSize="small" /> Sort
              </Box>
            </InputLabel>
            <Select
              labelId="sort-label"
              value={sortBy}
              label="Sort"
              onChange={(e) => setSortBy(e.target.value as SortOption)}
            >
              <MenuItem value="name">Name</MenuItem>
              <MenuItem value="endpoint">Endpoint ID</MenuItem>
              <MenuItem value="type">Type</MenuItem>
            </Select>
          </FormControl>

          <ToggleButtonGroup
            value={viewMode}
            exclusive
            onChange={(_, value) => value && setViewMode(value)}
            size="small"
          >
            <ToggleButton value="cards">
              <Tooltip title="Card View">
                <GridViewIcon />
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="tree">
              <Tooltip title="Tree View">
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
