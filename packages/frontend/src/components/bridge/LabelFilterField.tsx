import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { HomeAssistantLabel } from "../../api/labels.ts";
import type { WizardFilterType } from "./wizard-filter.ts";

// Home Assistant label management, opened in the top frame so it works from the
// add-on ingress iframe.
const haLabelsPath = "/config/labels";

interface LabelFilterFieldProps {
  labels: HomeAssistantLabel[];
  loading: boolean;
  value: string[];
  onChange: (labelIds: string[]) => void;
  onSwitchType: (type: WizardFilterType) => void;
}

// Label picker for the wizard. When Home Assistant has no labels yet, it shows
// a clear callout instead of an empty box, and offers the other filter types.
export function LabelFilterField({
  labels,
  loading,
  value,
  onChange,
  onSwitchType,
}: LabelFilterFieldProps) {
  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (labels.length === 0) {
    return (
      <Alert severity="info" sx={{ mt: 1 }}>
        <AlertTitle>No labels found</AlertTitle>
        <Typography variant="body2">
          Home Assistant has no labels yet, so there is nothing to filter by.
          Create them under{" "}
          <Link href={haLabelsPath} target="_top" rel="noopener">
            Settings &gt; Labels
          </Link>{" "}
          in Home Assistant, then reopen this wizard. Or pick a different filter
          type:
        </Typography>
        <Box display="flex" gap={1} flexWrap="wrap" mt={1}>
          <Button size="small" onClick={() => onSwitchType("domain")}>
            Use domains
          </Button>
          <Button size="small" onClick={() => onSwitchType("area")}>
            Use areas
          </Button>
          <Button size="small" onClick={() => onSwitchType("pattern")}>
            Use patterns
          </Button>
        </Box>
      </Alert>
    );
  }

  const toggle = (labelId: string) => {
    if (value.includes(labelId)) {
      onChange(value.filter((id) => id !== labelId));
    } else {
      onChange([...value, labelId]);
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Pick the labels to include. Entities carrying any selected label are
        exposed.
      </Typography>
      <Box display="flex" gap={0.75} flexWrap="wrap">
        {labels.map((label) => {
          const selected = value.includes(label.label_id);
          return (
            <Chip
              key={label.label_id}
              label={label.name}
              size="small"
              color={selected ? "primary" : "default"}
              variant={selected ? "filled" : "outlined"}
              onClick={() => toggle(label.label_id)}
            />
          );
        })}
      </Box>
    </Box>
  );
}
