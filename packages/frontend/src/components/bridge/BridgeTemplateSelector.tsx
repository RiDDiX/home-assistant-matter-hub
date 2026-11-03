import {
  type BridgeTemplate,
  bridgeTemplates,
} from "@home-assistant-matter-hub/common";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { iconTypeMap } from "./bridgeIconUtils.ts";

interface BridgeTemplateSelectorProps {
  selectedTemplate?: string;
  onSelect: (template: BridgeTemplate | null) => void;
}

export function BridgeTemplateSelector({
  selectedTemplate,
  onSelect,
}: BridgeTemplateSelectorProps) {
  const { t } = useTranslation();
  return (
    <Box>
      <Typography variant="subtitle1" gutterBottom fontWeight={600}>
        {t("bridge.templateHeading")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t("bridge.templateHint")}
      </Typography>

      <Grid container spacing={1.5} alignItems="flex-start">
        {bridgeTemplates.map((template) => {
          const isSelected = selectedTemplate === template.id;
          const Icon = iconTypeMap[template.icon] ?? iconTypeMap.default;
          return (
            <Grid key={template.id} size={{ xs: 12, sm: 6, md: 4 }}>
              <Card
                variant="outlined"
                sx={{
                  height: "100%",
                  borderColor: isSelected ? "primary.main" : "divider",
                  borderWidth: isSelected ? 2 : 1,
                  bgcolor: isSelected ? "action.selected" : "background.paper",
                  transition: "all 0.15s ease",
                }}
              >
                <CardActionArea
                  onClick={() => onSelect(isSelected ? null : template)}
                  aria-pressed={isSelected}
                  sx={{
                    p: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    justifyContent: "flex-start",
                  }}
                >
                  <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                    <Box display="flex" alignItems="center" gap={1} mb={0.5}>
                      <Icon fontSize="small" color="action" />
                      <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                        {template.name}
                      </Typography>
                      {isSelected && (
                        <CheckCircleIcon
                          color="primary"
                          sx={{ fontSize: 18 }}
                        />
                      )}
                    </Box>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: "-webkit-box",
                        WebkitLineClamp: !isSelected ? 2 : "none",
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {template.description}
                    </Typography>
                    {template.featureFlags?.serverMode && (
                      <Chip
                        label={t("bridge.serverMode")}
                        size="small"
                        color="warning"
                        variant="outlined"
                        sx={{ mt: 0.5 }}
                      />
                    )}
                    {template.featureFlags?.autoForceSync && (
                      <Chip
                        label={t("bridge.autoForceSync")}
                        size="small"
                        color="info"
                        variant="outlined"
                        sx={{ mt: 0.5, ml: 0.5 }}
                      />
                    )}
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          );
        })}
      </Grid>
    </Box>
  );
}
