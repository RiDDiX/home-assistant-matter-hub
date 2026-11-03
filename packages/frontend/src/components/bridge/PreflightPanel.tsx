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
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
        {open ? t("preflight.hideFix") : t("preflight.howToFix")}
      </Button>
      <Collapse in={open}>
        <Box sx={{ mt: 1 }}>
          {row.remediation.addonOption ? (
            <Typography variant="body2">
              <Trans
                i18nKey={
                  row.remediation.containerFlag
                    ? "preflight.addonOptionWithFlag"
                    : "preflight.addonOption"
                }
                values={{
                  option: row.remediation.addonOption,
                  flag: row.remediation.containerFlag,
                }}
                components={{ code: <code /> }}
              />
            </Typography>
          ) : (
            <Typography variant="body2">{t("preflight.hostSide")}</Typography>
          )}
          <Link
            href={row.remediation.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="body2"
            sx={{ display: "inline-block", mt: 0.5 }}
          >
            {t("preflight.docs")}
          </Link>
        </Box>
      </Collapse>
    </Alert>
  );
}

// Surfaces the existing network diagnostics inside the wizard so problems show
// up before the user pairs. Never blocks: it is advisory only.
export function PreflightPanel({ port }: PreflightPanelProps) {
  const { t } = useTranslation();
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
        setError(t("preflight.loadFailed"));
      }
    } catch {
      setError(t("preflight.unreachable"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  const rows = data ? mapDiagnosticsToPreflightRows(data) : [];
  const summary = data ? summarizeChecks(data) : null;
  const alexaPortHint = alexaPairingPortProblem(ALEXA_VENDOR_ID, port);

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {t("preflight.title")}
      </Typography>

      {alexaPortHint && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          <Trans i18nKey="preflight.alexaPort" values={{ port }} />
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
              label={t("preflight.passed", { count: summary.pass })}
              color="success"
              size="small"
              variant="outlined"
            />
          )}
          {summary.warn > 0 && (
            <Chip
              label={t("preflight.warnings", { count: summary.warn })}
              color="warning"
              size="small"
              variant="outlined"
            />
          )}
          {summary.fail > 0 && (
            <Chip
              label={t("preflight.failed", { count: summary.fail })}
              color="error"
              size="small"
              variant="outlined"
            />
          )}
        </Box>
      )}

      {data && rows.length === 0 && (
        <Alert severity="success">{t("preflight.allPassed")}</Alert>
      )}

      {rows.map((row) => (
        <RemediationRow key={row.name} row={row} />
      ))}
    </Box>
  );
}
