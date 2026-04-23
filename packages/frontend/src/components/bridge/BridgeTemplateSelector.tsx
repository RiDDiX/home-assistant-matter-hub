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

const templateIcons: Record<string, string> = {
  light: "💡",
  switch: "🔌",
  sensor: "📊",
  climate: "🌡️",
  lock: "🔒",
  vacuum: "🤖",
  media_player: "🎵",
  cover: "🪟",
  remote: "⚡",
  default: "🏠",
};

interface BridgeTemplateSelectorProps {
  selectedTemplate?: string;
  onSelect: (template: BridgeTemplate | null) => void;
}

export function BridgeTemplateSelector({
  selectedTemplate,
  onSelect,
}: BridgeTemplateSelectorProps) {
  return (
    <Box>
      <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 600 }}>
        Start from a Template (optional)
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Choose a preset to pre-fill the bridge configuration with recommended
        settings. You can customize everything afterwards.
      </Typography>

      <Grid container spacing={1.5} sx={{ alignItems: "flex-start" }}>
        {bridgeTemplates.map((template) => {
          const isSelected = selectedTemplate === template.id;
          return (
            <Grid
              key={template.id}
              sx={{ gridColumn: { xs: "span 12", sm: "span 6", md: "span 4" } }}
            >
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
                  sx={{
                    p: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    justifyContent: "flex-start",
                  }}
                >
                  <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        mb: 0.5,
                      }}
                    >
                      <Typography sx={{ fontSize: 20 }}>
                        {templateIcons[template.icon] ?? templateIcons.default}
                      </Typography>
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
                        label="Server Mode"
                        size="small"
                        color="warning"
                        variant="outlined"
                        sx={{ mt: 0.5, height: 20, fontSize: "0.65rem" }}
                      />
                    )}
                    {template.featureFlags?.autoForceSync && (
                      <Chip
                        label="Auto Force Sync"
                        size="small"
                        color="info"
                        variant="outlined"
                        sx={{
                          mt: 0.5,
                          ml: 0.5,
                          height: 20,
                          fontSize: "0.65rem",
                        }}
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
