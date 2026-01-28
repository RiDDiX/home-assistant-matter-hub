import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import DeviceHub from "@mui/icons-material/DeviceHub";
import Devices from "@mui/icons-material/Devices";
import Lightbulb from "@mui/icons-material/Lightbulb";
import Sensors from "@mui/icons-material/Sensors";
import Thermostat from "@mui/icons-material/Thermostat";
import Wifi from "@mui/icons-material/Wifi";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router";
import { navigation } from "../../routes.tsx";
import { BridgeStatusIcon } from "../bridge/BridgeStatusIcon.tsx";

export interface DeviceCardProps {
  bridge: BridgeDataWithMetadata;
}

const getDeviceIcon = (deviceCount: number) => {
  if (deviceCount === 0) return Devices;
  if (deviceCount <= 3) return Lightbulb;
  if (deviceCount <= 6) return Sensors;
  if (deviceCount <= 10) return Thermostat;
  return DeviceHub;
};

const getDeviceTypeColor = (deviceCount: number) => {
  if (deviceCount === 0) return "text.disabled";
  if (deviceCount <= 3) return "warning.main";
  if (deviceCount <= 6) return "info.main";
  if (deviceCount <= 10) return "success.main";
  return "primary.main";
};

export const DeviceCard = ({ bridge }: DeviceCardProps) => {
  const fabricCount = bridge.commissioning?.fabrics.length ?? 0;
  const DeviceIcon = getDeviceIcon(bridge.deviceCount);
  const deviceColor = getDeviceTypeColor(bridge.deviceCount);

  return (
    <Card
      variant="elevation"
      sx={{
        height: "100%",
        transition: "transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out",
        "&:hover": {
          transform: "translateY(-4px)",
          boxShadow: 4,
        },
      }}
    >
      <CardActionArea
        component={RouterLink}
        to={navigation.bridge(bridge.id)}
        sx={{ height: "100%" }}
      >
        <CardContent>
          <Box display="flex" alignItems="flex-start" gap={2}>
            <Avatar
              sx={{
                bgcolor: deviceColor,
                width: 56,
                height: 56,
                boxShadow: 2,
              }}
            >
              <DeviceIcon sx={{ fontSize: 32 }} />
            </Avatar>
            <Box flexGrow={1} minWidth={0}>
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <Typography
                  variant="h6"
                  component="div"
                  noWrap
                  sx={{ flexGrow: 1, fontWeight: 600 }}
                >
                  {bridge.name}
                </Typography>
                <BridgeStatusIcon status={bridge.status} />
              </Box>

              <Stack spacing={1} mb={2}>
                <Box display="flex" alignItems="center" gap={1}>
                  <Devices sx={{ fontSize: 16, color: "text.secondary" }} />
                  <Typography variant="body2" color="text.secondary">
                    {bridge.deviceCount} devices
                  </Typography>
                </Box>

                <Box display="flex" alignItems="center" gap={1}>
                  <Wifi sx={{ fontSize: 16, color: "text.secondary" }} />
                  <Typography variant="body2" color="text.secondary">
                    {fabricCount} fabric{fabricCount !== 1 ? "s" : ""}
                  </Typography>
                </Box>

                <Box display="flex" alignItems="center" gap={1}>
                  <Sensors sx={{ fontSize: 16, color: "text.secondary" }} />
                  <Typography variant="body2" color="text.secondary">
                    Port {bridge.port}
                  </Typography>
                </Box>
              </Stack>

              <Stack direction="row" spacing={1} flexWrap="wrap">
                <Chip
                  label={bridge.status}
                  size="small"
                  color={
                    bridge.status === "running"
                      ? "success"
                      : bridge.status === "stopped"
                        ? "default"
                        : "error"
                  }
                  variant="outlined"
                />
                {fabricCount > 0 && (
                  <Chip
                    icon={<Wifi />}
                    label={`${fabricCount} Connected`}
                    size="small"
                    color="primary"
                    variant="outlined"
                  />
                )}
                {bridge.deviceCount > 0 && (
                  <Chip
                    icon={<Devices />}
                    label={`${bridge.deviceCount} Devices`}
                    size="small"
                    color="info"
                    variant="outlined"
                  />
                )}
              </Stack>
            </Box>
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
};
