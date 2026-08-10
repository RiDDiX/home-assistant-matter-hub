import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
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

  // Number flags must never write true/false, the schema rejects it (#443).
  // An empty input removes the key so the backend default applies.
  const handleNumberChange = useCallback(
    (key: string, raw: string) => {
      const next = { ...formData };
      const parsed = Number(raw);
      if (raw.trim() === "" || Number.isNaN(parsed)) {
        delete next[key];
      } else {
        next[key] = parsed;
      }
      onChange(next, fieldPathId.path);
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
          const isNumber =
            flagSchema.type === "number" || flagSchema.type === "integer";
          const isDeprecated =
            flagSchema.title?.toLowerCase().includes("deprecated") ?? false;

          if (isNumber) {
            const value = formData[key] ?? flagSchema.default ?? "";
            return (
              <Grid key={key} size={{ xs: 12, sm: 6, lg: 4 }}>
                <Card
                  variant="outlined"
                  sx={{
                    height: "100%",
                    opacity: isDeprecated ? 0.6 : 1,
                    "&:hover": {
                      transform: "none",
                      boxShadow: "none",
                    },
                  }}
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
                    <TextField
                      type="number"
                      size="small"
                      fullWidth
                      label={flagSchema.title ?? key}
                      value={value}
                      disabled={disabled || readonly}
                      onChange={(e) => handleNumberChange(key, e.target.value)}
                      slotProps={{
                        htmlInput: {
                          min: flagSchema.minimum,
                          max: flagSchema.maximum,
                        },
                      }}
                    />
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ mt: 1, lineHeight: 1.4, flex: 1 }}
                    >
                      {flagSchema.description}
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            );
          }

          const value = formData[key] ?? flagSchema.default ?? false;
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
                      display="flex"
                      justifyContent="space-between"
                      alignItems="flex-start"
                      gap={1}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          variant="subtitle2"
                          fontWeight={600}
                          sx={{ lineHeight: 1.3 }}
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
