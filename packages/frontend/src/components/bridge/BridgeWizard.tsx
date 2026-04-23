import {
  type BridgeFeatureFlags,
  type BridgeIconType,
  type BridgeTemplate,
  type ControllerProfile,
  type CreateBridgeRequest,
  controllerProfiles,
  type HomeAssistantMatcher,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import CheckIcon from "@mui/icons-material/Check";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DevicesIcon from "@mui/icons-material/Devices";
import SettingsIcon from "@mui/icons-material/Settings";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Stepper from "@mui/material/Stepper";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createBridge as apiCreateBridge } from "../../api/bridges.js";
import { BridgeTemplateSelector } from "./BridgeTemplateSelector.js";

interface BridgeWizardProps {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

interface WizardBridge {
  name: string;
  port: number;
  serverMode: boolean;
  icon?: BridgeIconType;
  featureFlags?: BridgeFeatureFlags;
  filter: {
    include: HomeAssistantMatcher[];
    exclude: HomeAssistantMatcher[];
  };
}

const controllerIcons: Record<string, string> = {
  apple_home: "🍏",
  google_home: "🏠",
  alexa: "🔵",
  multi_controller: "🔀",
};

const stepKeys = [
  "bridgeWizard.stepTemplate",
  "bridgeWizard.stepController",
  "bridgeWizard.stepBridgeInfo",
  "bridgeWizard.stepEntityFilter",
  "bridgeWizard.stepFeatureFlags",
  "bridgeWizard.stepReview",
];

interface FlagOption {
  key: keyof BridgeFeatureFlags;
  label: string;
  description: string;
}

const wizardFlags: FlagOption[] = [
  {
    key: "autoComposedDevices",
    label: "Auto Compose Devices",
    description:
      "Combine related entities (battery, humidity, pressure, power, energy) from the same HA device into a single Matter endpoint.",
  },
  {
    key: "autoForceSync",
    label: "Auto Force Sync",
    description:
      "Periodically push all device states to controllers. Recommended for Google Home and Alexa to prevent devices from going offline.",
  },
  {
    key: "coverSwapOpenClose",
    label: "Invert Cover Direction",
    description:
      "Swap open/close direction for covers. Use this if your covers show the wrong position in Matter controllers.",
  },
  {
    key: "includeHiddenEntities",
    label: "Include Hidden Entities",
    description:
      "Also expose entities that are marked as hidden in Home Assistant.",
  },
];

export function BridgeWizard({ open, onClose, onComplete }: BridgeWizardProps) {
  const { t } = useTranslation();
  const [activeStep, setActiveStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [nextPort, setNextPort] = useState(5540);
  const [bridges, setBridges] = useState<WizardBridge[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<
    BridgeTemplate | undefined
  >();
  const [currentBridge, setCurrentBridge] = useState<WizardBridge>({
    name: "",
    port: 5540,
    serverMode: false,
    filter: { include: [], exclude: [] },
  });
  const [useWildcard, setUseWildcard] = useState(true);
  const [entityPattern, setEntityPattern] = useState("*");
  const [excludePattern, setExcludePattern] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedController, setSelectedController] = useState<
    ControllerProfile | undefined
  >();

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
      setSelectedTemplate(undefined);
      setCurrentBridge({
        name: "",
        port: nextPort,
        serverMode: false,
        filter: { include: [], exclude: [] },
      });
      setUseWildcard(true);
      setEntityPattern("*");
      setExcludePattern("");
      setError(null);
      setSelectedController(undefined);
    }
  }, [open, fetchNextPort, nextPort]);

  const applyTemplate = useCallback((template: BridgeTemplate | null) => {
    setSelectedTemplate(template ?? undefined);
    if (template) {
      setCurrentBridge((prev) => ({
        ...prev,
        name: template.name,
        serverMode: template.featureFlags?.serverMode ?? false,
        icon: template.icon,
        featureFlags: template.featureFlags,
        filter: { ...template.filter },
      }));
      // Pre-fill entity pattern from template filter
      const includes = template.filter.include;
      if (includes.length > 0) {
        setUseWildcard(false);
        if (template.featureFlags?.serverMode) {
          const patterns = includes.map((m) =>
            m.type === HomeAssistantMatcherType.Domain
              ? `${m.value}.*`
              : m.value,
          );
          setEntityPattern(patterns.join(", "));
        } else {
          setEntityPattern(includes.map((m) => m.value).join(", "));
        }
      }
      const excludes = template.filter.exclude;
      setExcludePattern(excludes.map((m) => m.value).join(", "));
    } else {
      setCurrentBridge((prev) => ({
        ...prev,
        name: "",
        serverMode: false,
        icon: undefined,
        featureFlags: undefined,
        filter: { include: [], exclude: [] },
      }));
      setUseWildcard(true);
      setEntityPattern("*");
      setExcludePattern("");
    }
  }, []);

  const applyController = useCallback((profile: ControllerProfile | null) => {
    setSelectedController(profile ?? undefined);
    if (profile) {
      setCurrentBridge((prev) => ({
        ...prev,
        featureFlags: {
          ...prev.featureFlags,
          ...profile.featureFlags,
        },
      }));
    }
  }, []);

  const handleNext = () => {
    if (activeStep === 0) {
      // Template step — just proceed
      setError(null);
    }
    if (activeStep === 1) {
      // Controller step — just proceed
      setError(null);
    }
    if (activeStep === 2) {
      if (!currentBridge.name.trim()) {
        setError(t("bridgeWizard.nameRequired"));
        return;
      }
      setError(null);
    }
    if (activeStep === 3) {
      let includeMatchers: HomeAssistantMatcher[];
      let excludeMatchers: HomeAssistantMatcher[];

      if (selectedTemplate && !currentBridge.serverMode) {
        // Use template filters directly
        includeMatchers = [...selectedTemplate.filter.include];
        excludeMatchers = [...selectedTemplate.filter.exclude];
      } else {
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

        includeMatchers = includePatterns.map((pattern) => ({
          type: HomeAssistantMatcherType.Pattern,
          value: pattern,
        }));
        excludeMatchers = excludePatterns.map((pattern) => ({
          type: HomeAssistantMatcherType.Pattern,
          value: pattern,
        }));
      }

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
    setSelectedTemplate(undefined);
    setSelectedController(undefined);
    setCurrentBridge({
      name: "",
      port: newPort,
      serverMode: false,
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
      const featureFlags: BridgeFeatureFlags = {
        ...currentBridge.featureFlags,
        ...(currentBridge.serverMode ? { serverMode: true } : {}),
      };
      const hasFlags = Object.keys(featureFlags).length > 0;
      const request: CreateBridgeRequest = {
        name: currentBridge.name,
        port: currentBridge.port,
        filter: currentBridge.filter,
        featureFlags: hasFlags ? featureFlags : undefined,
        icon: currentBridge.icon,
      };
      await apiCreateBridge(request);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("bridgeWizard.createFailed"));
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

  const renderTemplateStep = () => (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body1" gutterBottom>
        {t("bridgeWizard.templateDescription")}
      </Typography>
      <Box sx={{ mt: 2 }}>
        <BridgeTemplateSelector
          selectedTemplate={selectedTemplate?.id}
          onSelect={applyTemplate}
        />
      </Box>
    </Box>
  );

  const renderControllerStep = () => (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body1" gutterBottom>
        {t("bridgeWizard.controllerDescription")}
      </Typography>
      <Grid container spacing={1.5} sx={{ mt: 1 }}>
        {controllerProfiles.map((profile) => {
          const isSelected = selectedController?.id === profile.id;
          return (
            <Grid
              key={profile.id}
              sx={{ gridColumn: { xs: "span 12", sm: "span 6" } }}
            >
              <Card
                variant="outlined"
                sx={{
                  borderColor: isSelected ? "primary.main" : "divider",
                  borderWidth: isSelected ? 2 : 1,
                  bgcolor: isSelected ? "action.selected" : "background.paper",
                  transition: "all 0.15s ease",
                }}
              >
                <CardActionArea
                  onClick={() => applyController(isSelected ? null : profile)}
                  sx={{
                    p: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    justifyContent: "flex-start",
                  }}
                >
                  <CardContent
                    sx={{ p: 1.5, "&:last-child": { pb: 1.5 }, width: "100%" }}
                  >
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        mb: 0.5,
                      }}
                    >
                      <Typography sx={{ fontSize: 20 }}>
                        {controllerIcons[profile.id] ?? "\uD83C\uDFE0"}
                      </Typography>
                      <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                        {profile.name}
                      </Typography>
                      {isSelected && (
                        <CheckCircleIcon
                          color="primary"
                          sx={{ fontSize: 18 }}
                        />
                      )}
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      {profile.description}
                    </Typography>
                    {isSelected && (
                      <Box
                        sx={{
                          display: "flex",
                          gap: 0.5,
                          flexWrap: "wrap",
                          mt: 0.5,
                        }}
                      >
                        {Object.entries(profile.featureFlags)
                          .filter(([, v]) => v)
                          .map(([k]) => (
                            <Chip
                              key={k}
                              label={k
                                .replace(/^auto/, "")
                                .replace(/([A-Z])/g, " $1")
                                .trim()}
                              size="small"
                              variant="outlined"
                              sx={{ fontSize: "0.6rem", height: 18 }}
                            />
                          ))}
                      </Box>
                    )}
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          );
        })}
      </Grid>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mt: 2, display: "block" }}
      >
        {t("bridgeWizard.controllerHint")}
      </Typography>
    </Box>
  );

  const renderStep0 = () => (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body1" gutterBottom>
        {selectedTemplate
          ? t("bridgeWizard.templateApplied", { name: selectedTemplate.name })
          : t("bridgeWizard.bridgeInfoDescription")}
      </Typography>
      <TextField
        fullWidth
        label={t("bridgeWizard.bridgeName")}
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
        label={t("bridgeWizard.portLabel")}
        type="number"
        value={currentBridge.port}
        onChange={(e) =>
          setCurrentBridge((prev) => ({
            ...prev,
            port: parseInt(e.target.value, 10) || 5540,
          }))
        }
        margin="normal"
        helperText={t("bridgeWizard.portAutoAssign")}
      />
      <Tooltip
        title="Required for Robot Vacuums to work with Apple Home (Siri) and Alexa. Server Mode bridges support only ONE device."
        placement="right"
      >
        <FormControlLabel
          control={
            <Checkbox
              checked={currentBridge.serverMode}
              onChange={(e) =>
                setCurrentBridge((prev) => ({
                  ...prev,
                  serverMode: e.target.checked,
                }))
              }
              icon={<SmartToyIcon />}
              checkedIcon={<SmartToyIcon color="primary" />}
            />
          }
          label={t("bridgeWizard.serverModeLabel")}
          sx={{ mt: 1 }}
        />
      </Tooltip>
      {currentBridge.serverMode && (
        <Alert severity="info" sx={{ mt: 1 }}>
          <strong>Server Mode enabled:</strong> This bridge will expose a single
          device as a standalone Matter device. Add only ONE device (e.g., your
          vacuum) to this bridge. This is required for Apple Home Siri commands
          and Alexa discovery.
        </Alert>
      )}
      {bridges.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" color="text.secondary">
            {t("bridgeWizard.bridgesToCreate", { count: bridges.length })}:
          </Typography>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 1 }}>
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
        {selectedTemplate
          ? t("bridgeWizard.filterPreConfiguredFrom", {
              name: selectedTemplate.name,
            })
          : t("bridgeWizard.entityFilterDescription")}
      </Typography>
      {currentBridge.serverMode && (
        <Alert severity="warning" sx={{ mt: 1, mb: 1 }}>
          Server Mode requires exactly <strong>one</strong> entity. Change the
          filter to match only your device (e.g., <code>vacuum.my_vacuum</code>
          ).
        </Alert>
      )}
      {!selectedTemplate && (
        <FormControlLabel
          control={
            <Switch
              checked={useWildcard}
              onChange={(e) => setUseWildcard(e.target.checked)}
            />
          }
          label={t("bridgeWizard.includeAll")}
        />
      )}
      <TextField
        fullWidth
        label={
          currentBridge.serverMode
            ? "Entity ID"
            : useWildcard && !selectedTemplate
              ? "Include Pattern"
              : "Entity Filters"
        }
        value={
          selectedTemplate && !currentBridge.serverMode
            ? selectedTemplate.filter.include
                .map((m) => `${m.type}:${m.value}`)
                .join(", ")
            : entityPattern
        }
        onChange={(e) => setEntityPattern(e.target.value)}
        margin="normal"
        placeholder={
          useWildcard
            ? "* or light.*, switch.*"
            : "light.living_room, switch.kitchen"
        }
        helperText={
          currentBridge.serverMode
            ? "Server Mode supports only ONE device. Enter the exact entity ID (e.g., vacuum.my_vacuum)."
            : selectedTemplate
              ? "Pre-configured by template. Edit in the full editor after creation."
              : useWildcard
                ? "Use * for all, or patterns like light.*, switch.*"
                : "Enter specific entity IDs separated by commas"
        }
        disabled={!!selectedTemplate && !currentBridge.serverMode}
      />
      {!selectedTemplate && (
        <TextField
          fullWidth
          label={t("bridgeWizard.excludePatterns")}
          value={excludePattern}
          onChange={(e) => setExcludePattern(e.target.value)}
          margin="normal"
          placeholder="sensor.*, binary_sensor.*"
          helperText={t("bridgeWizard.excludeHelperText")}
        />
      )}
    </Box>
  );

  const renderFeatureFlagsStep = () => (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body1" gutterBottom>
        {t("bridgeWizard.featureFlagsDescription")}
        {selectedController
          ? ` ${t("bridgeWizard.recommendedFlags", { name: selectedController.name })}`
          : ` ${t("bridgeWizard.selectFlags")}`}
      </Typography>
      {wizardFlags.map((flag) => (
        <Box key={flag.key} sx={{ mt: 1 }}>
          <FormControlLabel
            control={
              <Switch
                checked={currentBridge.featureFlags?.[flag.key] === true}
                onChange={(e) =>
                  setCurrentBridge((prev) => ({
                    ...prev,
                    featureFlags: {
                      ...prev.featureFlags,
                      [flag.key]: e.target.checked,
                    },
                  }))
                }
              />
            }
            label={flag.label}
          />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", ml: 7, mt: -0.5 }}
          >
            {flag.description}
          </Typography>
        </Box>
      ))}
    </Box>
  );

  const renderStep2 = () => {
    const flagEntries = Object.entries(currentBridge.featureFlags ?? {}).filter(
      ([, v]) => v === true,
    );
    return (
      <Box sx={{ mt: 2 }}>
        <Typography variant="body1" gutterBottom>
          {t("bridgeWizard.reviewDescription")}
        </Typography>
        <Card variant="outlined" sx={{ mt: 2 }}>
          <CardContent>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
              <DevicesIcon />
              <Typography variant="h6">{currentBridge.name}</Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">
              {t("bridgeWizard.portLabel")}: {currentBridge.port}
            </Typography>
            {selectedTemplate && (
              <Chip
                label={`Template: ${selectedTemplate.name}`}
                size="small"
                color="info"
                variant="outlined"
                sx={{ mt: 1, mr: 0.5 }}
              />
            )}
            {currentBridge.serverMode && (
              <Chip
                icon={<SmartToyIcon />}
                label="Server Mode"
                color="primary"
                size="small"
                sx={{ mt: 1 }}
              />
            )}
            {flagEntries.length > 0 && (
              <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 1 }}>
                {flagEntries
                  .filter(([key]) => key !== "serverMode")
                  .map(([key]) => (
                    <Chip
                      key={key}
                      label={key}
                      size="small"
                      variant="outlined"
                      sx={{ fontSize: "0.7rem", height: 22 }}
                    />
                  ))}
              </Box>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Include:{" "}
              {currentBridge.filter.include.length > 0
                ? currentBridge.filter.include
                    .map((m) => `${m.type}:${m.value}`)
                    .join(", ")
                : entityPattern || "*"}
            </Typography>
            {error && (
              <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                {error}
              </Typography>
            )}
            {(excludePattern || currentBridge.filter.exclude.length > 0) && (
              <Typography variant="body2" color="text.secondary">
                Exclude:{" "}
                {currentBridge.filter.exclude.length > 0
                  ? currentBridge.filter.exclude.map((m) => m.value).join(", ")
                  : excludePattern}
              </Typography>
            )}
          </CardContent>
        </Card>
        {bridges.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2">
              {t("bridgeWizard.bridgesCreated", { count: bridges.length })}
            </Typography>
          </Box>
        )}
      </Box>
    );
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <SettingsIcon />
          <span>{t("bridgeWizard.title")}</span>
        </Box>
      </DialogTitle>
      <DialogContent>
        <Stepper activeStep={activeStep} sx={{ mt: 1 }}>
          {stepKeys.map((key) => (
            <Step key={key}>
              <StepLabel>{t(key)}</StepLabel>
            </Step>
          ))}
        </Stepper>
        {activeStep === 0 && renderTemplateStep()}
        {activeStep === 1 && renderControllerStep()}
        {activeStep === 2 && renderStep0()}
        {activeStep === 3 && renderStep1()}
        {activeStep === 4 && renderFeatureFlagsStep()}
        {activeStep === 5 && renderStep2()}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={loading}>
          {t("common.cancel")}
        </Button>
        <Box sx={{ flex: 1 }} />
        {activeStep > 0 && (
          <Button
            onClick={handleBack}
            startIcon={<ArrowBackIcon />}
            disabled={loading}
          >
            {t("common.back")}
          </Button>
        )}
        {activeStep < stepKeys.length - 1 && (
          <Button
            variant="contained"
            onClick={handleNext}
            endIcon={<ArrowForwardIcon />}
            disabled={loading}
          >
            {activeStep === 0 && !selectedTemplate
              ? t("bridgeWizard.skipTemplate")
              : activeStep === 1 && !selectedController
                ? t("common.skip")
                : t("common.next")}
          </Button>
        )}
        {activeStep === stepKeys.length - 1 && (
          <>
            <Button
              variant="outlined"
              onClick={handleAddAnother}
              startIcon={<AddIcon />}
              disabled={loading}
            >
              {t("bridgeWizard.addAnother")}
            </Button>
            <Button
              variant="contained"
              onClick={handleComplete}
              startIcon={
                loading ? <CircularProgress size={16} /> : <CheckIcon />
              }
              disabled={loading}
            >
              {loading
                ? t("bridgeWizard.creating")
                : t("bridgeWizard.createBridge")}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
