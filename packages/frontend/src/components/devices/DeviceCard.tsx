import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import Devices from "@mui/icons-material/Devices";
import Sensors from "@mui/icons-material/Sensors";
import Wifi from "@mui/icons-material/Wifi";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router";
import {
  checkBridgeIconExists,
  getBridgeIconUrl,
} from "../../api/bridge-icons";
import { navigation } from "../../routes.tsx";
import { BridgeStatusIcon } from "../bridge/BridgeStatusIcon.tsx";
import { getBridgeIcon, getBridgeIconColor } from "../bridge/bridgeIconUtils";

export interface DeviceCardProps {
  bridge: BridgeDataWithMetadata;
}

export const DeviceCard = ({ bridge }: DeviceCardProps) => {
  const fabricCount = bridge.commissioning?.fabrics.length ?? 0;
  const DeviceIcon = getBridgeIcon(bridge);
  const deviceColor = getBridgeIconColor(bridge);
  const [hasCustomIcon, setHasCustomIcon] = useState(false);

  useEffect(() => {
    checkBridgeIconExists(bridge.id).then(setHasCustomIcon);
  }, [bridge.id]);

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
            {hasCustomIcon ? (
              <Box
                component="img"
                src={getBridgeIconUrl(bridge.id)}
                alt={bridge.name}
                sx={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  objectFit: "cover",
                  boxShadow: 2,
                }}
              />
            ) : (
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
            )}
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
            </Box>
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
};
