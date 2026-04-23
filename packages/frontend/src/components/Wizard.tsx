import {
  type BridgeTemplate,
  bridgeTemplates,
  type HomeAssistantFilter,
} from "@home-assistant-matter-hub/common";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import CheckIcon from "@mui/icons-material/Check";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Grid from "@mui/material/Grid";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Stepper from "@mui/material/Stepper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createBridge } from "../api/bridges";
// import { WizardModeSelector } from "./WizardModeSelector";
import { createStandaloneDevice } from "../api/standalone-devices";

// Controller profiles for the wizard
const controllerProfiles = [
  {
    id: "apple_home",
    name: "Apple Home",
    icon: "🍏",
    description: "Use with Apple HomeKit (Siri) controllers.",
  },
  {
    id: "google_home",
    name: "Google Home",
    icon: "🏠",
    description: "Use with Google Home controllers.",
  },
  {
    id: "alexa",
    name: "Alexa",
    icon: "🔵",
    description: "Use with Amazon Alexa controllers.",
  },
  {
    id: "multi_controller",
    name: "Multi-Controller",
    icon: "🔀",
    description: "Expose to multiple controller types.",
  },
];

// Props for the Wizard component
export interface WizardProps {
  open: boolean;
  onClose: () => void;
  onComplete?: () => void;
  initialMode?: "bridge" | "standalone";
}

export function Wizard(props: WizardProps) {
  // Define the steps for the wizard
  const steps = [
    "Mode",
    "Template",
    "Controller",
    "Device Info",
    "Entities",
    "Review",
  ];
  const { t } = useTranslation();
  // Step 0: mode selection, then shared flow
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"bridge" | "standalone" | null>(
    props.initialMode ?? null,
  );
  const [selectedTemplate, setSelectedTemplate] =
    useState<BridgeTemplate | null>(null);
  const [name, setName] = useState("");
  const [controller, setController] = useState<string>("");
  const [deviceType, setDeviceType] = useState("");
  const [entities, setEntities] = useState("");
  const [port, setPort] = useState<number>(5540);
  const [filter, setFilter] = useState<HomeAssistantFilter>({
    include: [],
    exclude: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const handleFinish = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (mode === "standalone") {
        await createStandaloneDevice({
          name,
          deviceType,
          entities: entities
            .split(",")
            .map((e) => e.trim())
            .filter(Boolean),
        });
      } else if (mode === "bridge") {
        await createBridge({
          name,
          port,
          filter,
          icon: selectedTemplate?.icon,
          featureFlags: selectedTemplate?.featureFlags,
        });
      }
      setSubmitting(false);
      props.onComplete?.();
    } catch (err: any) {
      setSubmitting(false);
      setSubmitError(err?.message || String(err));
    }
  };

  // Step content renderers
  function ModeStep({
    mode,
    setMode,
  }: {
    mode: string | null;
    setMode: (m: "bridge" | "standalone") => void;
  }) {
    return (
      <Box sx={{ mt: 2, mb: 2 }}>
        <Typography variant="body1" gutterBottom>
          Select setup mode:
        </Typography>
        <Grid container spacing={2}>
          <Grid size={{ xs: 6 }}>
            <Card
              variant={mode === "bridge" ? "outlined" : undefined}
              sx={{
                borderColor: mode === "bridge" ? "primary.main" : "divider",
                borderWidth: mode === "bridge" ? 2 : 1,
              }}
            >
              <CardActionArea onClick={() => setMode("bridge")}>
                <CardContent>
                  <Typography variant="h6">Bridge</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Expose multiple devices to Matter controllers.
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
          <Grid size={{ xs: 6 }}>
            <Card
              variant={mode === "standalone" ? "outlined" : undefined}
              sx={{
                borderColor: mode === "standalone" ? "primary.main" : "divider",
                borderWidth: mode === "standalone" ? 2 : 1,
              }}
            >
              <CardActionArea onClick={() => setMode("standalone")}>
                <CardContent>
                  <Typography variant="h6">Standalone Device</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Expose a single device as a standalone Matter device.
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        </Grid>
      </Box>
    );
  }

  function ControllerStep({
    controller,
    setController,
  }: {
    controller: string;
    setController: (c: string) => void;
  }) {
    return (
      <Box sx={{ mt: 2, mb: 2 }}>
        <Typography variant="body1" gutterBottom>
          Select your primary controller:
        </Typography>
        <Grid container spacing={2}>
          {controllerProfiles.map((profile) => (
            <Grid size={{ xs: 6, sm: 3 }} key={profile.id}>
              <Card
                variant={controller === profile.id ? "outlined" : undefined}
                sx={{
                  borderColor:
                    controller === profile.id ? "primary.main" : "divider",
                  borderWidth: controller === profile.id ? 2 : 1,
                }}
              >
                <CardActionArea onClick={() => setController(profile.id)}>
                  <CardContent>
                    <Box sx={{ fontSize: 32 }}>{profile.icon}</Box>
                    <Typography variant="subtitle2">{profile.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {profile.description}
                    </Typography>
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Box>
    );
  }

  function DeviceInfoStep({
    name,
    setName,
    deviceType,
    setDeviceType,
    port,
    setPort,
    mode,
  }: {
    name: string;
    setName: (n: string) => void;
    deviceType: string;
    setDeviceType: (d: string) => void;
    port: number;
    setPort: (p: number) => void;
    mode: string | null;
  }) {
    return (
      <Box sx={{ mt: 2, mb: 2 }}>
        <TextField
          fullWidth
          label={mode === "standalone" ? "Device Name" : "Bridge Name"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          margin="normal"
          autoFocus
        />
        {mode === "standalone" && (
          <TextField
            fullWidth
            label="Device Type"
            value={deviceType}
            onChange={(e) => setDeviceType(e.target.value)}
            margin="normal"
          />
        )}
        {mode === "bridge" && (
          <TextField
            fullWidth
            label="Bridge Port"
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 5540)}
            margin="normal"
          />
        )}
      </Box>
    );
  }

  // Stepper labels (i18n)
  const stepLabels = [
    t("wizard.stepMode", "Mode"),
    t("wizard.stepTemplate", "Template"),
    t("wizard.stepController", "Controller"),
    t("wizard.stepDeviceInfo", "Device Info"),
    t("wizard.stepEntities", "Entities"),
    t("wizard.stepReview", "Review"),
  ];

  // Step skipping: if initialMode is provided, skip mode step
  useEffect(() => {
    if (props.initialMode && step === 0) {
      setMode(props.initialMode);
      setStep(1);
    }
    if (!props.open) {
      setStep(props.initialMode ? 1 : 0);
      setMode(props.initialMode ?? null);
      setSelectedTemplate(null);
      setName("");
      setController("");
      setDeviceType("");
      setEntities("");
      setPort(5540);
      setFilter({ include: [], exclude: [] });
      setError(null);
      setSubmitting(false);
      setSubmitError(null);
    }
  }, [props.open, props.initialMode, step]);

  // Validation logic
  const validateStep = () => {
    if (step === 0 && !mode) {
      setError(t("wizard.errorSelectMode", "Please select a mode."));
      return false;
    }
    if (step === 1 && !selectedTemplate) {
      setError(t("wizard.errorSelectTemplate", "Please select a template."));
      return false;
    }
    if (step === 2 && !controller) {
      setError(
        t("wizard.errorSelectController", "Please select a controller."),
      );
      return false;
    }
    if (step === 3 && !name.trim()) {
      setError(t("wizard.errorEnterName", "Please enter a name."));
      return false;
    }
    if (step === 3 && mode === "standalone" && !deviceType.trim()) {
      setError(t("wizard.errorEnterDeviceType", "Please enter a device type."));
      return false;
    }
    if (step === 4 && !entities.trim()) {
      setError(
        t("wizard.errorEnterEntities", "Please enter at least one entity."),
      );
      return false;
    }
    setError(null);
    return true;
  };

  // Enhanced handleNext with validation
  const handleNextEnhanced = () => {
    if (!validateStep()) return;
    setStep((s) => s + 1);
  };

  // Enhanced handleBack: clear error
  const handleBackEnhanced = () => {
    setError(null);
    setStep((s) => s - 1);
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("wizard.title")}</DialogTitle>
      <Stepper activeStep={step} alternativeLabel sx={{ px: 2, pt: 2, pb: 1 }}>
        {stepLabels.map((label, idx) => (
          <Step key={label} completed={step > idx}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>
      <DialogContent>
        {error && (
          <Box sx={{ mb: 2 }}>
            <Typography color="error" variant="body2">
              {error}
            </Typography>
          </Box>
        )}
        {submitError && (
          <Box sx={{ mb: 2 }}>
            <Typography color="error" variant="body2">
              {submitError}
            </Typography>
          </Box>
        )}
        {step === 0 && <ModeStep mode={mode} setMode={setMode} />}
        {step === 1 && (
          <Box>
            <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
              {t("wizard.stepTemplate")}
            </Typography>
            <Grid container spacing={2} sx={{ mb: 2 }}>
              {bridgeTemplates.map((template) => (
                <Grid size={{ xs: 12, sm: 6, md: 4 }} key={template.id}>
                  <Card
                    variant={
                      selectedTemplate?.id === template.id
                        ? "outlined"
                        : undefined
                    }
                    sx={{
                      borderColor:
                        selectedTemplate?.id === template.id
                          ? "primary.main"
                          : "divider",
                      borderWidth: selectedTemplate?.id === template.id ? 2 : 1,
                      bgcolor:
                        selectedTemplate?.id === template.id
                          ? "action.selected"
                          : "background.paper",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <CardActionArea
                      onClick={() => {
                        setSelectedTemplate(template);
                        setDeviceType(template.icon || "");
                        if (template.filter?.include?.length) {
                          setEntities(
                            template.filter.include
                              .map((inc) => inc.value)
                              .join(", "),
                          );
                        }
                      }}
                      sx={{ p: 2, height: "100%" }}
                    >
                      <Box sx={{ fontSize: 36, mb: 1 }}>
                        {template.icon || ""}
                      </Box>
                      <CardContent sx={{ p: 0 }}>
                        <Typography
                          variant="subtitle2"
                          sx={{ fontWeight: 600 }}
                        >
                          {template.name}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {template.description}
                        </Typography>
                      </CardContent>
                    </CardActionArea>
                  </Card>
                </Grid>
              ))}
            </Grid>
            <Button
              variant="outlined"
              onClick={() => {
                setSelectedTemplate(null);
                setDeviceType("");
                setEntities("");
              }}
              disabled={!selectedTemplate}
            >
              {t("wizard.clearTemplate")}
            </Button>
          </Box>
        )}
        {step === 2 && (
          <ControllerStep
            controller={controller}
            setController={setController}
          />
        )}
        {step === 3 && (
          <DeviceInfoStep
            name={name}
            setName={setName}
            deviceType={deviceType}
            setDeviceType={setDeviceType}
            port={port}
            setPort={setPort}
            mode={mode}
          />
        )}
        {step === 4 && (
          <TextField
            fullWidth
            label={t("standaloneDeviceWizard.entities")}
            value={entities}
            onChange={(e) => setEntities(e.target.value)}
            error={!!error}
            helperText={
              error || t("wizard.entitiesHelper", "Comma-separated entity IDs")
            }
            autoFocus
          />
        )}
        {step === 5 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle1" sx={{ mb: 1 }}>
              {t("standaloneDeviceWizard.reviewStep")}
            </Typography>
            <Typography>
              <b>{t("standaloneDeviceWizard.deviceName")}:</b> {name}
            </Typography>
            <Typography>
              <b>{t("standaloneDeviceWizard.stepController")}:</b>{" "}
              {controllerProfiles.find((c) => c.id === controller)?.name ||
                controller}
            </Typography>
            <Typography>
              <b>{t("standaloneDeviceWizard.deviceType")}:</b> {deviceType}
            </Typography>
            <Typography>
              <b>{t("standaloneDeviceWizard.entities")}:</b> {entities}
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={props.onClose} disabled={submitting}>
          {t("common.cancel")}
        </Button>
        <Box sx={{ flex: 1 }} />
        {step > 0 && (
          <Button
            onClick={handleBackEnhanced}
            startIcon={<ArrowBackIcon />}
            disabled={submitting}
          >
            {t("common.back")}
          </Button>
        )}
        {step < steps.length - 1 && (
          <Button
            variant="contained"
            onClick={handleNextEnhanced}
            endIcon={<ArrowForwardIcon />}
            disabled={submitting || (step === 0 && !mode)}
          >
            {t("common.next")}
          </Button>
        )}
        {step === steps.length - 1 && (
          <Button
            variant="contained"
            onClick={handleFinish}
            startIcon={<CheckIcon />}
            disabled={submitting}
          >
            {submitting ? t("wizard.creating") : t("common.finish")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
