import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import AddIcon from "@mui/icons-material/Add";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DevicesIcon from "@mui/icons-material/Devices";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import FilterListIcon from "@mui/icons-material/FilterList";
import InfoIcon from "@mui/icons-material/Info";
import QrCode2Icon from "@mui/icons-material/QrCode2";
import RemoveIcon from "@mui/icons-material/Remove";
import WifiIcon from "@mui/icons-material/Wifi";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { FabricList } from "../fabric/FabricList.tsx";

export interface BridgeDetailsProps {
  readonly bridge: BridgeDataWithMetadata;
}

export const BridgeDetails = ({ bridge }: BridgeDetailsProps) => {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 4 }}>
        <PairingCard bridge={bridge} />
      </Grid>
      <Grid size={{ xs: 12, md: 4 }}>
        <InfoCard bridge={bridge} />
      </Grid>
      <Grid size={{ xs: 12, md: 4 }}>
        <FabricsCard bridge={bridge} />
      </Grid>
      <Grid size={{ xs: 12 }}>
        <FiltersCard bridge={bridge} />
      </Grid>
      <Grid size={{ xs: 12 }}>
        <FailedEntities bridge={bridge} />
      </Grid>
    </Grid>
  );
};

const PairingCard = ({ bridge }: { bridge: BridgeDataWithMetadata }) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!bridge.commissioning) {
    return (
      <Card sx={{ height: "100%" }}>
        <CardContent>
          <Box display="flex" alignItems="center" gap={1} mb={2}>
            <Avatar sx={{ bgcolor: "grey.500" }}>
              <QrCode2Icon />
            </Avatar>
            <Typography variant="h6">Pairing</Typography>
          </Box>
          <Typography color="text.secondary">
            Bridge is not running. Start the bridge to see pairing information.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <>
      <Card sx={{ height: "100%" }}>
        <CardContent>
          <Box display="flex" alignItems="center" gap={1} mb={2}>
            <Avatar sx={{ bgcolor: "primary.main" }}>
              <QrCode2Icon />
            </Avatar>
            <Typography variant="h6">Pairing</Typography>
          </Box>

          <Box
            display="flex"
            flexDirection="column"
            alignItems="center"
            gap={2}
          >
            <Box position="relative">
              {bridge.commissioning.isCommissioned && (
                <Box
                  position="absolute"
                  top="50%"
                  left="50%"
                  sx={{
                    transform: "translate(-50%, -50%) rotate(-45deg)",
                    zIndex: 1,
                  }}
                >
                  <Chip label="Commissioned" color="success" size="small" />
                </Box>
              )}
              <Box
                sx={{
                  background: "white",
                  padding: 1,
                  borderRadius: 1,
                  opacity: bridge.commissioning.isCommissioned ? 0.5 : 1,
                }}
              >
                <QRCodeSVG
                  value={bridge.commissioning.qrPairingCode}
                  size={120}
                />
              </Box>
            </Box>

            <Stack spacing={1} width="100%">
              <Box
                display="flex"
                alignItems="center"
                justifyContent="space-between"
              >
                <Typography variant="body2" color="text.secondary">
                  Manual Code:
                </Typography>
                <Box display="flex" alignItems="center" gap={0.5}>
                  <Typography variant="body2" fontFamily="monospace">
                    {bridge.commissioning.manualPairingCode}
                  </Typography>
                  <IconButton
                    size="small"
                    onClick={() =>
                      copyToClipboard(bridge.commissioning!.manualPairingCode)
                    }
                  >
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
            </Stack>

            {bridge.commissioning.isCommissioned && (
              <Button
                variant="outlined"
                size="small"
                startIcon={<QrCode2Icon />}
                onClick={() => setDialogOpen(true)}
                fullWidth
              >
                Add Another Controller
              </Button>
            )}
          </Box>
        </CardContent>
      </Card>

      <PairingDialog
        bridge={bridge}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
};

const InfoCard = ({ bridge }: { bridge: BridgeDataWithMetadata }) => {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent>
        <Box display="flex" alignItems="center" gap={1} mb={2}>
          <Avatar sx={{ bgcolor: "info.main" }}>
            <InfoIcon />
          </Avatar>
          <Typography variant="h6">Bridge Info</Typography>
        </Box>

        <Stack spacing={1.5}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Bridge ID
            </Typography>
            <Typography variant="body2" fontFamily="monospace" noWrap>
              {bridge.id}
            </Typography>
          </Box>
          <Divider />
          <Box display="flex" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">
              Port
            </Typography>
            <Typography variant="body2" fontWeight="medium">
              {bridge.port}
            </Typography>
          </Box>
          <Box display="flex" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">
              Devices
            </Typography>
            <Chip
              icon={<DevicesIcon />}
              label={bridge.deviceCount}
              size="small"
              color="primary"
              variant="outlined"
            />
          </Box>
          {bridge.commissioning && (
            <>
              <Box display="flex" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  Passcode
                </Typography>
                <Typography variant="body2" fontFamily="monospace">
                  {bridge.commissioning.passcode}
                </Typography>
              </Box>
              <Box display="flex" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  Discriminator
                </Typography>
                <Typography variant="body2" fontFamily="monospace">
                  {bridge.commissioning.discriminator}
                </Typography>
              </Box>
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
};

const FabricsCard = ({ bridge }: { bridge: BridgeDataWithMetadata }) => {
  const fabrics = bridge.commissioning?.fabrics ?? [];

  return (
    <Card sx={{ height: "100%" }}>
      <CardContent>
        <Box display="flex" alignItems="center" gap={1} mb={2}>
          <Avatar
            sx={{ bgcolor: fabrics.length > 0 ? "success.main" : "grey.500" }}
          >
            <WifiIcon />
          </Avatar>
          <Typography variant="h6">
            Connected Fabrics ({fabrics.length})
          </Typography>
        </Box>

        {fabrics.length === 0 ? (
          <Typography color="text.secondary">
            No controllers connected yet. Scan the QR code with your Matter
            controller to pair this bridge.
          </Typography>
        ) : (
          <FabricList fabrics={fabrics} />
        )}
      </CardContent>
    </Card>
  );
};

const FiltersCard = ({ bridge }: { bridge: BridgeDataWithMetadata }) => {
  const hasFilters =
    bridge.filter.include.length > 0 || bridge.filter.exclude.length > 0;

  if (!hasFilters) {
    return null;
  }

  return (
    <Card>
      <CardContent>
        <Box display="flex" alignItems="center" gap={1} mb={2}>
          <Avatar sx={{ bgcolor: "warning.main" }}>
            <FilterListIcon />
          </Avatar>
          <Typography variant="h6">Entity Filters</Typography>
        </Box>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {bridge.filter.include.map((filter) => (
            <Chip
              key={`include-${filter.type}-${filter.value}`}
              size="small"
              icon={<AddIcon />}
              label={
                <span>
                  <strong>{filter.type}</strong>: {filter.value}
                </span>
              }
              color="success"
              variant="outlined"
            />
          ))}
          {bridge.filter.exclude.map((filter) => (
            <Chip
              key={`exclude-${filter.type}-${filter.value}`}
              size="small"
              icon={<RemoveIcon />}
              label={
                <span>
                  <strong>{filter.type}</strong>: {filter.value}
                </span>
              }
              color="error"
              variant="outlined"
            />
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
};

const PairingDialog = ({
  bridge,
  open,
  onClose,
}: {
  bridge: BridgeDataWithMetadata;
  open: boolean;
  onClose: () => void;
}) => {
  if (!bridge.commissioning) {
    return null;
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Box display="flex" alignItems="center" gap={1}>
          <QrCode2Icon />
          Add Another Controller
        </Box>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Scan this QR code with your Matter controller (Apple Home, Google
          Home, Alexa, etc.) to add this bridge to another ecosystem.
        </Typography>

        <Box display="flex" justifyContent="center" my={3}>
          <Box
            sx={{
              background: "white",
              padding: 2,
              borderRadius: 1,
            }}
          >
            <QRCodeSVG value={bridge.commissioning.qrPairingCode} size={200} />
          </Box>
        </Box>

        <Stack spacing={1}>
          <Box
            display="flex"
            alignItems="center"
            justifyContent="space-between"
          >
            <Typography variant="body2">
              <strong>Manual Code:</strong>{" "}
              {bridge.commissioning.manualPairingCode}
            </Typography>
            <Tooltip title="Copy">
              <IconButton
                size="small"
                onClick={() =>
                  copyToClipboard(bridge.commissioning!.manualPairingCode)
                }
              >
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          <Box
            display="flex"
            alignItems="center"
            justifyContent="space-between"
          >
            <Typography variant="body2">
              <strong>Passcode:</strong> {bridge.commissioning.passcode}
            </Typography>
            <Tooltip title="Copy">
              <IconButton
                size="small"
                onClick={() =>
                  copyToClipboard(bridge.commissioning!.passcode.toString())
                }
              >
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          <Box
            display="flex"
            alignItems="center"
            justifyContent="space-between"
          >
            <Typography variant="body2">
              <strong>Discriminator:</strong>{" "}
              {bridge.commissioning.discriminator}
            </Typography>
            <Tooltip title="Copy">
              <IconButton
                size="small"
                onClick={() =>
                  copyToClipboard(
                    bridge.commissioning!.discriminator.toString(),
                  )
                }
              >
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </Stack>

        <Alert severity="info" sx={{ mt: 2 }}>
          <Typography variant="body2">
            Matter supports connecting the same bridge to multiple controllers
            simultaneously. Each controller will have independent control.
          </Typography>
        </Alert>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};

const FailedEntities = ({ bridge }: { bridge: BridgeDataWithMetadata }) => {
  const failedEntities = bridge.failedEntities;
  if (!failedEntities || failedEntities.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardContent>
        <Alert severity="warning" icon={<ErrorOutlineIcon />}>
          <AlertTitle>Failed Entities ({failedEntities.length})</AlertTitle>
          <Typography variant="body2" component="div">
            The following entities could not be added to the bridge:
          </Typography>
          <Box sx={{ mt: 1, maxHeight: 200, overflow: "auto" }}>
            {failedEntities.map((entity) => (
              <Box key={entity.entityId} sx={{ mb: 0.5 }}>
                <Typography variant="body2" component="span" fontWeight="bold">
                  {entity.entityId}
                </Typography>
                <Typography
                  variant="body2"
                  component="span"
                  color="text.secondary"
                >
                  {" — "}
                  {entity.reason}
                </Typography>
              </Box>
            ))}
          </Box>
        </Alert>
      </CardContent>
    </Card>
  );
};
