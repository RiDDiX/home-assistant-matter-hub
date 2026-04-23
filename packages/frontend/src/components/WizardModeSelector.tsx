import SettingsIcon from "@mui/icons-material/Settings";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import { useState } from "react";

export interface WizardModeSelectorProps {
  open: boolean;
  onSelect: (mode: "bridge" | "standalone") => void;
}

export function WizardModeSelector({
  open,
  onSelect,
}: WizardModeSelectorProps) {
  const [selected, setSelected] = useState<"bridge" | "standalone" | null>(
    null,
  );

  return (
    <Dialog open={open} maxWidth="xs" fullWidth>
      <DialogTitle>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <SettingsIcon />
          <span>Select Setup Mode</span>
        </Box>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body1" sx={{ mb: 2 }}>
          What would you like to set up?
        </Typography>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Button
            variant={selected === "bridge" ? "contained" : "outlined"}
            onClick={() => setSelected("bridge")}
            sx={{ py: 2, fontWeight: 600 }}
            fullWidth
          >
            Bridge
          </Button>
          <Button
            variant={selected === "standalone" ? "contained" : "outlined"}
            onClick={() => setSelected("standalone")}
            sx={{ py: 2, fontWeight: 600 }}
            fullWidth
          >
            Standalone Device
          </Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => selected && onSelect(selected)}
          variant="contained"
          disabled={!selected}
        >
          Continue
        </Button>
      </DialogActions>
    </Dialog>
  );
}
