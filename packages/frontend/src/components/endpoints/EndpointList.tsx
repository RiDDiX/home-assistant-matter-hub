import type { EndpointData } from "@home-assistant-matter-hub/common";
import GridViewIcon from "@mui/icons-material/GridView";
import ListIcon from "@mui/icons-material/List";
import SortIcon from "@mui/icons-material/Sort";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import Grid from "@mui/material/Grid";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";
import { EndpointCard } from "./EndpointCard.tsx";
import { getEndpointName } from "./EndpointName.tsx";
import { EndpointState } from "./EndpointState.tsx";
import { EndpointTreeView, type SortOption } from "./EndpointTreeView.tsx";

export interface EndpointListProps {
  endpoint: EndpointData;
}

export const EndpointList = (props: EndpointListProps) => {
  const [selectedItem, setSelectedItem] = useState<EndpointData | undefined>(
    undefined,
  );
  const [sortBy, setSortBy] = useState<SortOption>("name");
  const [viewMode, setViewMode] = useState<"cards" | "tree">("cards");
  const [searchTerm, setSearchTerm] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);

  const endpoints = useMemo(() => {
    const parts = props.endpoint.parts ?? [];

    const filtered = parts.filter((ep) => {
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
  }, [props.endpoint.parts, searchTerm, sortBy]);

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
        <Typography variant="h6" component="span">
          Endpoints ({endpoints.length})
        </Typography>

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
              <EndpointCard endpoint={ep} onClick={() => handleCardClick(ep)} />
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
    </Box>
  );
};
