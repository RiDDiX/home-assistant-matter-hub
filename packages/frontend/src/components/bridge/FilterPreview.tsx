import PreviewIcon from "@mui/icons-material/Preview";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";

interface FilterPreviewProps {
  filter: {
    include: Array<{ type: string; value: string }>;
    exclude: Array<{ type: string; value: string }>;
    includeMode?: string;
  };
}

interface PreviewResult {
  total: number;
  entities: Array<{
    entity_id: string;
    friendly_name?: string;
    domain: string;
  }>;
  truncated: boolean;
}

const domainToMatterType: Record<string, string> = {
  light: "Light",
  switch: "On/Off Plug-in Unit",
  lock: "Door Lock",
  fan: "Fan",
  binary_sensor: "Sensor",
  sensor: "Sensor",
  cover: "Window Covering",
  climate: "Thermostat",
  media_player: "Speaker / Video Player",
  vacuum: "Robot Vacuum Cleaner",
  humidifier: "Humidifier",
  valve: "Water Valve",
  alarm_control_panel: "On/Off Plug-in Unit",
  event: "Generic Switch",
  button: "Generic Switch",
  input_button: "Generic Switch",
  automation: "On/Off Switch",
  script: "On/Off Switch",
  scene: "On/Off Switch",
  remote: "On/Off",
  water_heater: "Water Heater",
  input_boolean: "On/Off Plug-in Unit",
  select: "Mode Select",
  input_select: "Mode Select",
  siren: "On/Off Plug-in Unit",
};

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export function FilterPreview({ filter }: FilterPreviewProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterJsonRef = useRef<string>("");

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("api/matter/filter-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filter),
      });

      const text = await response.text();
      const parsed = tryParseJson(text);

      if (!response.ok) {
        const errorMessage =
          typeof parsed === "object" && parsed !== null && "error" in parsed
            ? String((parsed as { error?: unknown }).error)
            : text || "Failed to fetch preview";
        throw new Error(errorMessage);
      }

      const data = (parsed ?? tryParseJson(text)) as PreviewResult;
      setResult(data);
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  // Auto-refresh when filter changes (debounced 800ms)
  useEffect(() => {
    const hasFilters =
      filter.include.length > 0 &&
      filter.include.some((f) => f.type && f.value);

    if (!hasFilters) {
      setResult(null);
      setExpanded(false);
      return;
    }

    const newJson = JSON.stringify(filter);
    if (newJson === filterJsonRef.current) return;
    filterJsonRef.current = newJson;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchPreview();
    }, 800);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [filter, fetchPreview]);

  const domainCounts = result
    ? result.entities.reduce(
        (acc, e) => {
          acc[e.domain] = (acc[e.domain] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      )
    : {};

  const warnings: string[] = [];
  if (result) {
    const hasVacuum = result.entities.some((e) => e.domain === "vacuum");
    if (hasVacuum) {
      warnings.push(
        "This filter includes a vacuum. Consider using Server Mode (single device per bridge) for Apple Home/Alexa compatibility.",
      );
    }
    if (result.total > 50) {
      warnings.push(
        `${result.total} entities is a large number. Consider splitting across multiple bridges for better stability.`,
      );
    }
    const unsupportedDomains = Object.keys(domainCounts).filter(
      (d) => !domainToMatterType[d],
    );
    if (unsupportedDomains.length > 0) {
      warnings.push(
        `Unsupported domains will be skipped: ${unsupportedDomains.join(", ")}`,
      );
    }
  }

  return (
    <Box sx={{ mt: 2 }}>
      <Button
        variant="outlined"
        startIcon={loading ? <CircularProgress size={16} /> : <PreviewIcon />}
        onClick={fetchPreview}
        disabled={loading}
        size="small"
      >
        {loading ? "Loading..." : "Preview Matching Entities"}
      </Button>

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}

      <Collapse in={expanded && result !== null}>
        {result && (
          <Box sx={{ mt: 2 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: "bold" }}>
                {result.total} entities match
              </Typography>
              {result.truncated && (
                <Chip
                  label="Showing first 100"
                  size="small"
                  color="warning"
                  variant="outlined"
                />
              )}
            </Box>

            {warnings.length > 0 && (
              <Stack spacing={0.5} sx={{ mb: 1.5 }}>
                {warnings.map((warning) => (
                  <Alert
                    key={warning}
                    severity="warning"
                    variant="outlined"
                    icon={
                      warning.includes("vacuum") ? (
                        <RocketLaunchIcon fontSize="small" />
                      ) : (
                        <WarningAmberIcon fontSize="small" />
                      )
                    }
                    sx={{ py: 0 }}
                  >
                    <Typography variant="caption">{warning}</Typography>
                  </Alert>
                ))}
              </Stack>
            )}

            <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mb: 2 }}>
              {Object.entries(domainCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([domain, count]) => (
                  <Chip
                    key={domain}
                    label={`${domain}: ${count}${domainToMatterType[domain] ? ` → ${domainToMatterType[domain]}` : ""}`}
                    size="small"
                    variant="outlined"
                    color={domainToMatterType[domain] ? "default" : "warning"}
                  />
                ))}
            </Box>

            <List
              dense
              sx={{
                maxHeight: 200,
                overflow: "auto",
                bgcolor: "background.paper",
                borderRadius: 1,
                border: 1,
                borderColor: "divider",
              }}
            >
              {result.entities.map((entity) => (
                <ListItem key={entity.entity_id} divider>
                  <ListItemText
                    primary={
                      <Typography variant="body2">
                        {entity.friendly_name || entity.entity_id}
                      </Typography>
                    }
                    secondary={
                      <Typography
                        variant="caption"
                        sx={{ fontFamily: "monospace" }}
                      >
                        {entity.entity_id}
                        {domainToMatterType[entity.domain]
                          ? ` → ${domainToMatterType[entity.domain]}`
                          : ""}
                      </Typography>
                    }
                  />
                </ListItem>
              ))}
            </List>

            <Button
              size="small"
              onClick={() => setExpanded(false)}
              sx={{ mt: 1 }}
            >
              Hide Preview
            </Button>
          </Box>
        )}
      </Collapse>
    </Box>
  );
}
