import DevicesIcon from "@mui/icons-material/Devices";
import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
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
import { useBridges } from "../../hooks/data/bridges";
import { loadBridges } from "../../state/bridges/bridge-actions";
import { useAppDispatch } from "../../state/hooks";

interface DeviceInfo {
  bridgeId: string;
  bridgeName: string;
  deviceId: string;
  deviceName: string;
  deviceType: string;
  entityCount: number;
  entities: Array<{
    entityId: string;
    entityName: string;
    entityType: string;
    domain: string;
  }>;
}

const getDeviceIcon = (deviceType: string) => {
  switch (deviceType.toLowerCase()) {
    case "light":
    case "lights":
      return "💡";
    case "switch":
    case "switches":
      return "🔌";
    case "lock":
    case "locks":
      return "🔒";
    case "thermostat":
    case "climate":
      return "🌡️";
    case "sensor":
    case "sensors":
      return "📊";
    case "fan":
    case "fans":
      return "🌀";
    case "cover":
    case "covers":
      return "🪟";
    case "media_player":
    case "media":
      return "🎵";
    case "button":
    case "buttons":
      return "🔘";
    case "scene":
    case "scenes":
      return "🎬";
    case "script":
    case "scripts":
      return "📜";
    case "vacuum":
    case "vacuums":
      return "🤖";
    case "water_heater":
    case "water":
      return "💧";
    case "camera":
    case "cameras":
      return "📷";
    default:
      return "📱";
  }
};

const getDeviceTypeColor = (deviceType: string) => {
  switch (deviceType.toLowerCase()) {
    case "light":
    case "lights":
      return "#FFD700";
    case "switch":
    case "switches":
      return "#4CAF50";
    case "lock":
    case "locks":
      return "#2196F3";
    case "thermostat":
    case "climate":
      return "#FF5722";
    case "sensor":
    case "sensors":
      return "#9C27B0";
    case "fan":
    case "fans":
      return "#00BCD4";
    case "cover":
    case "covers":
      return "#795548";
    case "media_player":
    case "media":
      return "#E91E63";
    case "button":
    case "buttons":
      return "#607D8B";
    case "scene":
    case "scenes":
      return "#FF9800";
    case "script":
    case "scripts":
      return "#3F51B5";
    case "vacuum":
    case "vacuums":
      return "#009688";
    case "water_heater":
    case "water":
      return "#03A9F4";
    case "camera":
    case "cameras":
      return "#F44336";
    default:
      return "#757575";
  }
};

export const DevicesPage = () => {
  const dispatch = useAppDispatch();
  const { content: bridges, isLoading } = useBridges();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedBridge, setSelectedBridge] = useState<string>("");
  const [selectedType, setSelectedType] = useState<string>("");
  const [page, setPage] = useState(1);
  const itemsPerPage = 12;

  useEffect(() => {
    dispatch(loadBridges());
  }, [dispatch]);

  // Extract devices from bridges
  const devices = useMemo(() => {
    const allDevices: DeviceInfo[] = [];

    (bridges || []).forEach((bridge) => {
      // Create a mock device for each bridge since endpoints structure is not available
      const mockDevice: DeviceInfo = {
        bridgeId: bridge.id,
        bridgeName: bridge.name,
        deviceId: bridge.id,
        deviceName: bridge.name,
        deviceType: "bridge",
        entityCount: bridge.deviceCount,
        entities: [], // Would need to be populated from actual bridge data
      };

      allDevices.push(mockDevice);
    });

    return allDevices;
  }, [bridges]);

  // Filter devices
  const filteredDevices = useMemo(() => {
    return devices.filter((device) => {
      const matchesSearch =
        device.deviceName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        device.bridgeName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        device.deviceType.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesBridge =
        !selectedBridge || device.bridgeId === selectedBridge;
      const matchesType = !selectedType || device.deviceType === selectedType;

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
    const types = new Set(devices.map((d) => d.deviceType));
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
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      <span>{getDeviceIcon(type)}</span>
                      {type}
                    </Box>
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
            key={`${device.bridgeId}-${device.deviceId}`}
            size={{ xs: 12, sm: 6, lg: 4 }}
          >
            <Card
              sx={{
                height: "100%",
                transition:
                  "transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out",
                "&:hover": {
                  transform: "translateY(-4px)",
                  boxShadow: 4,
                },
              }}
            >
              <CardContent>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 2,
                    mb: 2,
                  }}
                >
                  <Box
                    sx={{
                      fontSize: 40,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 60,
                      height: 60,
                      borderRadius: 2,
                      backgroundColor: `${getDeviceTypeColor(device.deviceType)}20`,
                    }}
                  >
                    {getDeviceIcon(device.deviceType)}
                  </Box>
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography variant="h6" noWrap>
                      {device.deviceName}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {device.bridgeName}
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                      <Chip
                        label={device.deviceType}
                        size="small"
                        sx={{
                          backgroundColor: `${getDeviceTypeColor(device.deviceType)}20`,
                          color: getDeviceTypeColor(device.deviceType),
                        }}
                      />
                      <Chip
                        label={`${device.entityCount} entities`}
                        size="small"
                        variant="outlined"
                      />
                    </Stack>
                  </Box>
                </Box>

                {/* Entities */}
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Entities ({device.entityCount})
                  </Typography>
                  <Stack spacing={0.5}>
                    {device.entities.slice(0, 3).map((entity) => (
                      <Box
                        key={entity.entityId}
                        sx={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          p: 0.5,
                          borderRadius: 1,
                          backgroundColor: "action.hover",
                        }}
                      >
                        <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>
                          {entity.entityName}
                        </Typography>
                        <Chip
                          label={entity.domain}
                          size="small"
                          variant="outlined"
                          sx={{ fontSize: "0.7rem", height: 20 }}
                        />
                      </Box>
                    ))}
                    {device.entityCount > 3 && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ textAlign: "center", mt: 1 }}
                      >
                        ... and {device.entityCount - 3} more
                      </Typography>
                    )}
                  </Stack>
                </Box>
              </CardContent>
            </Card>
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
