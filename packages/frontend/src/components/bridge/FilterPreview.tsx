import PreviewIcon from "@mui/icons-material/Preview";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { useState } from "react";

interface FilterPreviewProps {
  filter: {
    include: Array<{ type: string; value: string }>;
    exclude: Array<{ type: string; value: string }>;
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

export function FilterPreview({ filter }: FilterPreviewProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const tryParseJson = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const fetchPreview = async () => {
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
  };

  const domainCounts = result
    ? result.entities.reduce(
        (acc, e) => {
          acc[e.domain] = (acc[e.domain] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      )
    : {};

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
            <Box display="flex" alignItems="center" gap={1} mb={1}>
              <Typography variant="subtitle1" fontWeight="bold">
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

            <Box display="flex" gap={0.5} flexWrap="wrap" mb={2}>
              {Object.entries(domainCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([domain, count]) => (
                  <Chip
                    key={domain}
                    label={`${domain}: ${count}`}
                    size="small"
                    variant="outlined"
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
                    primary={entity.friendly_name || entity.entity_id}
                    secondary={
                      entity.friendly_name ? entity.entity_id : undefined
                    }
                    primaryTypographyProps={{ variant: "body2" }}
                    secondaryTypographyProps={{ variant: "caption" }}
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
