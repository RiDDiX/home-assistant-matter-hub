import { alexaPairingPortProblem } from "@home-assistant-matter-hub/common";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import {
  mapDiagnosticsToPreflightRows,
  type NetworkDiagnosticResult,
  type PreflightRow,
  summarizeChecks,
} from "./preflight.ts";

// Amazon Alexa fabric root vendor id (0x1217). Passed to the shared helper so
// the port check reads as "would an Alexa controller fail to pair here".
const ALEXA_VENDOR_ID = 0x1217;

interface PreflightPanelProps {
  port: number;
}

const severityFor = (
  status: PreflightRow["status"],
): "warning" | "error" | "success" => {
  if (status === "fail") return "error";
  if (status === "warn") return "warning";
  return "success";
};

function RemediationRow({ row }: { row: PreflightRow }) {
  const [open, setOpen] = useState(false);
  return (
    <Alert severity={severityFor(row.status)} sx={{ mb: 1 }}>
      <strong>{row.message}</strong>
      {row.detail && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {row.detail}
        </Typography>
      )}
      <Button size="small" onClick={() => setOpen((v) => !v)} sx={{ mt: 0.5 }}>
        {open ? "Hide fix" : "How to fix"}
      </Button>
      <Collapse in={open}>
        <Box sx={{ mt: 1 }}>
          {row.remediation.addonOption ? (
            <Typography variant="body2">
              Add-on: set the <code>{row.remediation.addonOption}</code> option
              {row.remediation.containerFlag && (
                <>
                  {" "}
                  (container: <code>{row.remediation.containerFlag}</code>)
                </>
              )}
              . This is a start option, so restart the add-on after changing it.
            </Typography>
          ) : (
            <Typography variant="body2">
              This one is fixed on the host or network side, not from here.
            </Typography>
          )}
          <Link
            href={row.remediation.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="body2"
            sx={{ display: "inline-block", mt: 0.5 }}
          >
            Connectivity troubleshooting docs
          </Link>
        </Box>
      </Collapse>
    </Alert>
  );
}

// Surfaces the existing network diagnostics inside the wizard so problems show
// up before the user pairs. Never blocks: it is advisory only.
export function PreflightPanel({ port }: PreflightPanelProps) {
  const [data, setData] = useState<NetworkDiagnosticResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDiagnostics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("api/network");
      if (res.ok) {
        setData((await res.json()) as NetworkDiagnosticResult);
      } else {
        setError("Could not load network diagnostics.");
      }
    } catch {
      setError("Could not reach the server for network diagnostics.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  const rows = data ? mapDiagnosticsToPreflightRows(data) : [];
  const summary = data ? summarizeChecks(data) : null;
  const alexaPortHint = alexaPairingPortProblem(ALEXA_VENDOR_ID, port);

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        Network preflight
      </Typography>

      {alexaPortHint && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          Alexa only pairs on port <strong>5540</strong>. This bridge uses port{" "}
          <strong>{port}</strong>, so Alexa will roll back the pairing. Keep the
          port at 5540 if you plan to use Alexa.
        </Alert>
      )}

      {loading && <CircularProgress size={20} />}

      {error && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}

      {summary && (
        <Box display="flex" gap={1} mb={1} flexWrap="wrap">
          {summary.pass > 0 && (
            <Chip
              label={`${summary.pass} passed`}
              color="success"
              size="small"
              variant="outlined"
            />
          )}
          {summary.warn > 0 && (
            <Chip
              label={`${summary.warn} warnings`}
              color="warning"
              size="small"
              variant="outlined"
            />
          )}
          {summary.fail > 0 && (
            <Chip
              label={`${summary.fail} failed`}
              color="error"
              size="small"
              variant="outlined"
            />
          )}
        </Box>
      )}

      {data && rows.length === 0 && (
        <Alert severity="success">
          All network checks passed. You are good to pair.
        </Alert>
      )}

      {rows.map((row) => (
        <RemediationRow key={row.name} row={row} />
      ))}
    </Box>
  );
}
