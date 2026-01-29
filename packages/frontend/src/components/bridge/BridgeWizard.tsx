import {
  type CreateBridgeRequest,
  type HomeAssistantMatcher,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import CheckIcon from "@mui/icons-material/Check";
import DevicesIcon from "@mui/icons-material/Devices";
import SettingsIcon from "@mui/icons-material/Settings";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Stepper from "@mui/material/Stepper";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { createBridge as apiCreateBridge } from "../../api/bridges.js";

interface BridgeWizardProps {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

interface WizardBridge {
  name: string;
  port: number;
  filter: {
    include: HomeAssistantMatcher[];
    exclude: HomeAssistantMatcher[];
  };
}

const steps = ["Bridge Info", "Entity Filter", "Review & Create"];

export function BridgeWizard({ open, onClose, onComplete }: BridgeWizardProps) {
  const [activeStep, setActiveStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [nextPort, setNextPort] = useState(5540);
  const [bridges, setBridges] = useState<WizardBridge[]>([]);
  const [currentBridge, setCurrentBridge] = useState<WizardBridge>({
    name: "",
    port: 5540,
    filter: { include: [], exclude: [] },
  });
  const [useWildcard, setUseWildcard] = useState(true);
  const [entityPattern, setEntityPattern] = useState("*");
  const [excludePattern, setExcludePattern] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fetchNextPort = useCallback(async () => {
    try {
      const res = await fetch("api/matter/next-port");
      if (res.ok) {
        const data = (await res.json()) as { port: number };
        setNextPort(data.port);
        setCurrentBridge((prev) => ({ ...prev, port: data.port }));
      }
    } catch {
      // Use default port
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchNextPort();
      setActiveStep(0);
      setBridges([]);
      setCurrentBridge({
        name: "",
        port: nextPort,
        filter: { include: [], exclude: [] },
      });
      setUseWildcard(true);
      setEntityPattern("*");
      setExcludePattern("");
      setError(null);
    }
  }, [open, fetchNextPort, nextPort]);

  const handleNext = () => {
    if (activeStep === 0) {
      if (!currentBridge.name.trim()) {
        setError("Please enter a bridge name");
        return;
      }
      setError(null);
    }
    if (activeStep === 1) {
      const includePatterns = useWildcard
        ? [entityPattern || "*"]
        : entityPattern
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
      const excludePatterns = excludePattern
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const includeMatchers: HomeAssistantMatcher[] = includePatterns.map(
        (pattern) => ({
          type: HomeAssistantMatcherType.Pattern,
          value: pattern,
        }),
      );
      const excludeMatchers: HomeAssistantMatcher[] = excludePatterns.map(
        (pattern) => ({
          type: HomeAssistantMatcherType.Pattern,
          value: pattern,
        }),
      );

      setCurrentBridge((prev) => ({
        ...prev,
        filter: {
          include: includeMatchers,
          exclude: excludeMatchers,
        },
      }));
    }
    setActiveStep((prev) => prev + 1);
  };

  const handleBack = () => {
    setActiveStep((prev) => prev - 1);
    setError(null);
  };

  const handleAddAnother = async () => {
    await createBridgeAsync();
    const newPort = nextPort + bridges.length + 1;
    setBridges((prev) => [...prev, currentBridge]);
    setCurrentBridge({
      name: "",
      port: newPort,
      filter: { include: [], exclude: [] },
    });
    setActiveStep(0);
    setUseWildcard(true);
    setEntityPattern("*");
    setExcludePattern("");
  };

  const createBridgeAsync = async () => {
    setLoading(true);
    setError(null);
    try {
      const request: CreateBridgeRequest = {
        name: currentBridge.name,
        port: currentBridge.port,
        filter: currentBridge.filter,
      };
      await apiCreateBridge(request);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create bridge");
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleComplete = async () => {
    const success = await createBridgeAsync();
    if (success) {
      onComplete();
      onClose();
    }
  };

  const renderStep0 = () => (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body1" gutterBottom>
        Let's set up a new Matter bridge. First, give it a name and port.
      </Typography>
      <TextField
        fullWidth
        label="Bridge Name"
        value={currentBridge.name}
        onChange={(e) =>
          setCurrentBridge((prev) => ({ ...prev, name: e.target.value }))
        }
        margin="normal"
        placeholder="e.g., Living Room, Kitchen, All Lights"
        error={!!error}
        helperText={error}
      />
      <TextField
        fullWidth
        label="Port"
        type="number"
        value={currentBridge.port}
        onChange={(e) =>
          setCurrentBridge((prev) => ({
            ...prev,
            port: parseInt(e.target.value, 10) || 5540,
          }))
        }
        margin="normal"
        helperText="Automatically assigned to next available port"
      />
      {bridges.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" color="text.secondary">
            Bridges to create ({bridges.length}):
          </Typography>
          <Box display="flex" gap={1} flexWrap="wrap" mt={1}>
            {bridges.map((b) => (
              <Chip
                key={b.port}
                label={`${b.name} (:${b.port})`}
                size="small"
              />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );

  const renderStep1 = () => (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body1" gutterBottom>
        Configure which entities should be included in this bridge.
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={useWildcard}
            onChange={(e) => setUseWildcard(e.target.checked)}
          />
        }
        label="Include all entities (wildcard)"
      />
      <TextField
        fullWidth
        label={useWildcard ? "Include Pattern" : "Entity IDs (comma-separated)"}
        value={entityPattern}
        onChange={(e) => setEntityPattern(e.target.value)}
        margin="normal"
        placeholder={
          useWildcard
            ? "* or light.*, switch.*"
            : "light.living_room, switch.kitchen"
        }
        helperText={
          useWildcard
            ? "Use * for all, or patterns like light.*, switch.*"
            : "Enter specific entity IDs separated by commas"
        }
      />
      <TextField
        fullWidth
        label="Exclude Patterns (optional)"
        value={excludePattern}
        onChange={(e) => setExcludePattern(e.target.value)}
        margin="normal"
        placeholder="sensor.*, binary_sensor.*"
        helperText="Patterns to exclude, comma-separated"
      />
    </Box>
  );

  const renderStep2 = () => (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body1" gutterBottom>
        Review your bridge configuration:
      </Typography>
      <Card variant="outlined" sx={{ mt: 2 }}>
        <CardContent>
          <Box display="flex" alignItems="center" gap={1} mb={1}>
            <DevicesIcon />
            <Typography variant="h6">{currentBridge.name}</Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            Port: {currentBridge.port}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Include:{" "}
            {currentBridge.filter.include.length > 0
              ? currentBridge.filter.include.map((m) => m.value).join(", ")
              : entityPattern || "*"}
          </Typography>
          {error && (
            <Typography variant="body2" color="error" sx={{ mt: 1 }}>
              {error}
            </Typography>
          )}
          {excludePattern && (
            <Typography variant="body2" color="text.secondary">
              Exclude: {excludePattern}
            </Typography>
          )}
        </CardContent>
      </Card>
      {bridges.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2">
            {bridges.length} bridge(s) already created in this session
          </Typography>
        </Box>
      )}
    </Box>
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Box display="flex" alignItems="center" gap={1}>
          <SettingsIcon />
          <span>Bridge Setup Wizard</span>
        </Box>
      </DialogTitle>
      <DialogContent>
        <Stepper activeStep={activeStep} sx={{ mt: 1 }}>
          {steps.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>
        {activeStep === 0 && renderStep0()}
        {activeStep === 1 && renderStep1()}
        {activeStep === 2 && renderStep2()}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Box sx={{ flex: 1 }} />
        {activeStep > 0 && (
          <Button
            onClick={handleBack}
            startIcon={<ArrowBackIcon />}
            disabled={loading}
          >
            Back
          </Button>
        )}
        {activeStep < steps.length - 1 && (
          <Button
            variant="contained"
            onClick={handleNext}
            endIcon={<ArrowForwardIcon />}
            disabled={loading}
          >
            Next
          </Button>
        )}
        {activeStep === steps.length - 1 && (
          <>
            <Button
              variant="outlined"
              onClick={handleAddAnother}
              startIcon={<AddIcon />}
              disabled={loading}
            >
              Add Another
            </Button>
            <Button
              variant="contained"
              onClick={handleComplete}
              startIcon={
                loading ? <CircularProgress size={16} /> : <CheckIcon />
              }
              disabled={loading}
            >
              {loading ? "Creating..." : "Create Bridge"}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
