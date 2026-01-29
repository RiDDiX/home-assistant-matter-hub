import type { EndpointData } from "@home-assistant-matter-hub/common";
import DevicesIcon from "@mui/icons-material/Devices";
import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import Grid from "@mui/material/Grid";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Pagination from "@mui/material/Pagination";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EndpointCard } from "../../components/endpoints/EndpointCard";
import { getEndpointName } from "../../components/endpoints/EndpointName";
import { useBridges } from "../../hooks/data/bridges";
import { loadBridges } from "../../state/bridges/bridge-actions";
import { loadDevices } from "../../state/devices/device-actions";
import { useAppDispatch, useAppSelector } from "../../state/hooks";

interface DeviceInfo {
  bridgeId: string;
  bridgeName: string;
  endpoint: EndpointData;
}

export const DevicesPage = () => {
  const dispatch = useAppDispatch();
  const { content: bridges, isLoading: bridgesLoading } = useBridges();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedBridge, setSelectedBridge] = useState<string>("");
  const [selectedType, setSelectedType] = useState<string>("");
  const [page, setPage] = useState(1);
  const itemsPerPage = 12;

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

  // Extract all endpoints from all bridges
  const devices = useMemo(() => {
    const allDevices: DeviceInfo[] = [];

    (bridges || []).forEach((bridge) => {
      const deviceState = allDeviceStates[bridge.id];
      const rootEndpoint = deviceState?.content;

      if (rootEndpoint?.parts) {
        rootEndpoint.parts.forEach((endpoint: EndpointData) => {
          allDevices.push({
            bridgeId: bridge.id,
            bridgeName: bridge.name,
            endpoint,
          });
        });
      }
    });

    return allDevices;
  }, [bridges, allDeviceStates]);

  const isLoading =
    bridgesLoading || (bridges && bridges.length > 0 && devices.length === 0);

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

  // Pagination
  const totalPages = Math.ceil(filteredDevices.length / itemsPerPage);
  const paginatedDevices = filteredDevices.slice(
    (page - 1) * itemsPerPage,
    page * itemsPerPage,
  );

  // Get unique device types
  const deviceTypes = useMemo(() => {
    const types = new Set(devices.map((d) => d.endpoint.type.name));
    return Array.from(types).sort();
  }, [devices]);

  const handleRefresh = useCallback(() => {
    dispatch(loadBridges());
  }, [dispatch]);

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
        All Devices
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={handleRefresh}
          sx={{ ml: "auto" }}
        >
          Refresh
        </Button>
      </Typography>

      {/* Filters */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Stack
            spacing={2}
            direction={{ xs: "column", md: "row" }}
            alignItems={{ md: "center" }}
          >
            <TextField
              label="Search devices..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              sx={{ flexGrow: 1 }}
            />

            <FormControl sx={{ minWidth: 200 }}>
              <InputLabel>Bridge</InputLabel>
              <Select
                value={selectedBridge}
                label="Bridge"
                onChange={(e) => setSelectedBridge(e.target.value)}
              >
                <MenuItem value="">All Bridges</MenuItem>
                {(bridges || []).map((bridge) => (
                  <MenuItem key={bridge.id} value={bridge.id}>
                    {bridge.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl sx={{ minWidth: 200 }}>
              <InputLabel>Device Type</InputLabel>
              <Select
                value={selectedType}
                label="Device Type"
                onChange={(e) => setSelectedType(e.target.value)}
              >
                <MenuItem value="">All Types</MenuItem>
                {deviceTypes.map((type) => (
                  <MenuItem key={type} value={type}>
                    {type}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
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
            />
          </Grid>
        ))}
      </Grid>

      {/* Pagination */}
      {totalPages > 1 && (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 3 }}>
          <Pagination
            count={totalPages}
            page={page}
            onChange={(_, newPage) => setPage(newPage)}
            color="primary"
          />
        </Box>
      )}

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
    </Box>
  );
};
