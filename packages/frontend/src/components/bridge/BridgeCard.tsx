import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import DeviceHub from "@mui/icons-material/DeviceHub";
import Devices from "@mui/icons-material/Devices";
import Language from "@mui/icons-material/Language";
import Router from "@mui/icons-material/Router";
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
import { BridgeStatusIcon } from "./BridgeStatusIcon.tsx";

export interface BridgeCardProps {
  bridge: BridgeDataWithMetadata;
}

export const BridgeCard = ({ bridge }: BridgeCardProps) => {
  const fabricCount = bridge.commissioning?.fabrics.length ?? 0;

  return (
    <Card variant="elevation" sx={{ height: "100%" }}>
      <CardActionArea
        component={RouterLink}
        to={navigation.bridge(bridge.id)}
        sx={{ height: "100%" }}
      >
        <CardContent>
          <Box display="flex" alignItems="flex-start" gap={2}>
            <Avatar
              sx={{
                bgcolor: "primary.main",
                width: 48,
                height: 48,
              }}
            >
              <Router />
            </Avatar>
            <Box flexGrow={1} minWidth={0}>
              <Box display="flex" alignItems="center" gap={1} mb={0.5}>
                <Typography
                  variant="h6"
                  component="div"
                  noWrap
                  sx={{ flexGrow: 1 }}
                >
                  {bridge.name}
                </Typography>
                <BridgeStatusIcon status={bridge.status} />
              </Box>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 1.5 }}
              >
                Port {bridge.port}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip
                  icon={<Devices fontSize="small" />}
                  label={`${bridge.deviceCount} Devices`}
                  size="small"
                  variant="outlined"
                />
                <Chip
                  icon={<DeviceHub fontSize="small" />}
                  label={`${fabricCount} Fabric${fabricCount !== 1 ? "s" : ""}`}
                  size="small"
                  variant="outlined"
                  color={fabricCount > 0 ? "success" : "default"}
                />
                {bridge.commissioning?.fabrics.some((f) =>
                  f.label?.toLowerCase().includes("google"),
                ) && (
                  <Chip
                    icon={<Language fontSize="small" />}
                    label="Google"
                    size="small"
                    color="primary"
                    variant="filled"
                  />
                )}
                {bridge.commissioning?.fabrics.some((f) =>
                  f.label?.toLowerCase().includes("amazon"),
                ) && (
                  <Chip
                    icon={<Language fontSize="small" />}
                    label="Alexa"
                    size="small"
                    color="secondary"
                    variant="filled"
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
