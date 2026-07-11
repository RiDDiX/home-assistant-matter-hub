import HubIcon from "@mui/icons-material/Hub";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { getVendorName } from "../fabric/vendor-names.ts";
import {
  type FabricInput,
  type SessionInput,
  summarizeFabricHealth,
} from "./fabric-health.ts";

export function FabricHealthCard({
  fabrics,
  sessions,
}: {
  fabrics: FabricInput[];
  sessions: SessionInput[];
}) {
  const { t } = useTranslation();
  const rows = summarizeFabricHealth(fabrics, sessions);
  if (rows.length === 0) {
    return null;
  }
  return (
    <Card variant="outlined">
      <CardContent>
        <Box display="flex" alignItems="center" gap={1} mb={1.5}>
          <HubIcon fontSize="small" color="action" />
          <Typography variant="h6">{t("health.fabricHealth")}</Typography>
        </Box>
        <Stack spacing={1}>
          {rows.map((f) => {
            const status = !f.connected
              ? { label: t("health.offline"), color: "default" as const }
              : f.stale
                ? { label: t("health.stale"), color: "warning" as const }
                : { label: t("health.connected"), color: "success" as const };
            return (
              <Box
                key={f.fabricIndex}
                display="flex"
                alignItems="center"
                flexWrap="wrap"
                gap={1}
              >
                <Chip
                  size="small"
                  color={status.color}
                  label={status.label}
                  sx={{ minWidth: 88 }}
                />
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {getVendorName(f.rootVendorId)}
                  {f.label ? ` (${f.label})` : ""}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t("health.subscriptions")}: {f.subscriptions}
                  {f.lastActiveMsAgo != null
                    ? ` | ${t("health.lastActiveAgo", {
                        seconds: Math.round(f.lastActiveMsAgo / 1000),
                      })}`
                    : ""}
                </Typography>
              </Box>
            );
          })}
        </Stack>
      </CardContent>
    </Card>
  );
}
