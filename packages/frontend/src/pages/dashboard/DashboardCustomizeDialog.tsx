import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import RestoreIcon from "@mui/icons-material/Restore";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Tooltip from "@mui/material/Tooltip";
import {
  AVAILABLE_WIDGETS,
  type DashboardWidgetConfig,
} from "../../hooks/use-dashboard-widgets.ts";

interface DashboardCustomizeDialogProps {
  readonly open: boolean;
  readonly config: DashboardWidgetConfig;
  readonly onToggle: (id: string) => void;
  readonly onMove: (id: string, direction: "up" | "down") => void;
  readonly onReset: () => void;
  readonly onClose: () => void;
}

export function DashboardCustomizeDialog({
  open,
  config,
  onToggle,
  onMove,
  onReset,
  onClose,
}: DashboardCustomizeDialogProps) {
  const widgetMap = new Map(AVAILABLE_WIDGETS.map((w) => [w.id, w]));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Customize Dashboard</DialogTitle>
      <DialogContent dividers>
        <List disablePadding>
          {config.order.map((id, index) => {
            const widget = widgetMap.get(id);
            if (!widget) return null;
            const hidden = config.hidden.includes(id);
            return (
              <ListItem
                key={id}
                sx={{ opacity: hidden ? 0.5 : 1 }}
                secondaryAction={
                  <>
                    <Tooltip title="Move up">
                      <span>
                        <IconButton
                          size="small"
                          disabled={index === 0}
                          onClick={() => onMove(id, "up")}
                        >
                          <ArrowUpwardIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Move down">
                      <span>
                        <IconButton
                          size="small"
                          disabled={index === config.order.length - 1}
                          onClick={() => onMove(id, "down")}
                        >
                          <ArrowDownwardIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </>
                }
              >
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <IconButton size="small" onClick={() => onToggle(id)}>
                    {hidden ? (
                      <VisibilityOffIcon fontSize="small" />
                    ) : (
                      <VisibilityIcon fontSize="small" color="primary" />
                    )}
                  </IconButton>
                </ListItemIcon>
                <ListItemText
                  primary={widget.label}
                  secondary={widget.description}
                  secondaryTypographyProps={{ variant: "caption" }}
                />
              </ListItem>
            );
          })}
        </List>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<RestoreIcon />} onClick={onReset} color="warning">
          Reset
        </Button>
        <Button onClick={onClose} variant="contained">
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
