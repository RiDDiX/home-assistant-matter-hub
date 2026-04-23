import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import type { FieldProps } from "@rjsf/utils";
import type { JSONSchema7 } from "json-schema";
import { useCallback } from "react";

export function FeatureFlagsField(props: FieldProps) {
  const {
    schema,
    formData = {},
    onChange,
    disabled,
    readonly,
    fieldPathId,
  } = props;
  const properties = (schema.properties ?? {}) as Record<string, JSONSchema7>;

  const handleToggle = useCallback(
    (key: string, checked: boolean) => {
      onChange({ ...formData, [key]: checked }, fieldPathId.path);
    },
    [formData, onChange, fieldPathId],
  );

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        Feature Flags
      </Typography>
      <Grid container spacing={2}>
        {Object.entries(properties).map(([key, flagSchema]) => {
          const value = formData[key] ?? flagSchema.default ?? false;
          const isDeprecated =
            flagSchema.title?.toLowerCase().includes("deprecated") ?? false;

          return (
            <Grid key={key} size={{ xs: 12, sm: 6, lg: 4 }}>
              <Card
                variant="outlined"
                sx={{
                  height: "100%",
                  opacity: isDeprecated ? 0.6 : 1,
                  transition: "border-color 0.2s, box-shadow 0.2s",
                  borderColor: value ? "primary.main" : "divider",
                  "&:hover": {
                    transform: "none",
                    boxShadow: "none",
                  },
                }}
              >
                <CardActionArea
                  onClick={() => {
                    if (!disabled && !readonly) handleToggle(key, !value);
                  }}
                  disabled={disabled || readonly}
                  sx={{ height: "100%" }}
                >
                  <CardContent
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                      p: 2,
                      "&:last-child": { pb: 2 },
                    }}
                  >
                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: 1,
                      }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          variant="subtitle2"
                          sx={{ fontWeight: 600, lineHeight: 1.2 }}
                        >
                          {flagSchema.title ?? key}
                        </Typography>
                        {value && (
                          <Chip
                            label="Active"
                            size="small"
                            color="primary"
                            variant="outlined"
                            sx={{ mt: 0.5, height: 20, fontSize: "0.7rem" }}
                          />
                        )}
                      </Box>
                      <Switch
                        checked={value}
                        size="small"
                        disabled={disabled || readonly}
                        tabIndex={-1}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleToggle(key, e.target.checked)}
                      />
                    </Box>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ mt: 1, lineHeight: 1.4, flex: 1 }}
                    >
                      {flagSchema.description}
                    </Typography>
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
