import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface NetworkInterfaceInfo {
  name: string;
  ipv4: string[];
  ipv6: string[];
  mac: string;
  internal: boolean;
}

interface NetworkDiagnosticCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  detail?: string;
}

interface NetworkDiagnosticResult {
  timestamp: string;
  interfaces: NetworkInterfaceInfo[];
  checks: NetworkDiagnosticCheck[];
  matterConfig: {
    boundInterface: string | null;
    ipv4Enabled: boolean;
  };
}

const statusColor = (
  status: "pass" | "warn" | "fail",
): "success" | "warning" | "error" => {
  if (status === "pass") return "success";
  if (status === "warn") return "warning";
  return "error";
};

export function NetworkDiagnosticCard() {
  const { t } = useTranslation();
  const [data, setData] = useState<NetworkDiagnosticResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchDiagnostics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("api/network");
      if (res.ok) {
        setData((await res.json()) as NetworkDiagnosticResult);
      } else {
        setError(t("health.fetchFailed"));
      }
    } catch {
      setError(t("health.connectionError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  const passCount = data?.checks.filter((c) => c.status === "pass").length ?? 0;
  const warnCount = data?.checks.filter((c) => c.status === "warn").length ?? 0;
  const failCount = data?.checks.filter((c) => c.status === "fail").length ?? 0;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="center"
        mb={1}
      >
        <Typography variant="subtitle1" fontWeight="bold">
          {t("health.networkDiagnostics")}
        </Typography>
        <Button size="small" onClick={fetchDiagnostics} disabled={loading}>
          {loading ? <CircularProgress size={16} /> : t("health.refresh")}
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}

      {data && (
        <>
          <Box display="flex" gap={1} mb={1.5} flexWrap="wrap">
            {passCount > 0 && (
              <Chip
                label={`${passCount} ${t("health.checksPassed")}`}
                color="success"
                size="small"
                variant="outlined"
              />
            )}
            {warnCount > 0 && (
              <Chip
                label={`${warnCount} ${t("health.checksWarning")}`}
                color="warning"
                size="small"
                variant="outlined"
              />
            )}
            {failCount > 0 && (
              <Chip
                label={`${failCount} ${t("health.checksFailed")}`}
                color="error"
                size="small"
                variant="outlined"
              />
            )}
            <Chip
              label={
                data.matterConfig.boundInterface
                  ? `mDNS: ${data.matterConfig.boundInterface}`
                  : "mDNS: all interfaces"
              }
              size="small"
              variant="outlined"
            />
            <Chip
              label={`IPv4: ${data.matterConfig.ipv4Enabled ? "on" : "off"}`}
              size="small"
              variant="outlined"
            />
          </Box>

          {data.checks
            .filter((c) => c.status !== "pass")
            .map((check) => (
              <Alert
                key={check.name}
                severity={statusColor(check.status)}
                sx={{ mb: 1 }}
              >
                <strong>{check.message}</strong>
                {check.detail && (
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    {check.detail}
                  </Typography>
                )}
              </Alert>
            ))}

          <Button
            size="small"
            onClick={() => setExpanded(!expanded)}
            sx={{ mt: 0.5 }}
          >
            {expanded ? t("health.hideDetails") : t("health.showDetails")}
          </Button>

          <Collapse in={expanded}>
            <Typography variant="subtitle2" sx={{ mt: 1, mb: 0.5 }}>
              {t("health.allChecks")}
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("health.check")}</TableCell>
                  <TableCell>{t("health.statusLabel")}</TableCell>
                  <TableCell>{t("health.message")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.checks.map((check) => (
                  <TableRow key={check.name}>
                    <TableCell>
                      <Typography variant="body2">{check.name}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={check.status}
                        color={statusColor(check.status)}
                        size="small"
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{check.message}</Typography>
                      {check.detail && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          display="block"
                        >
                          {check.detail}
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>
              {t("health.networkInterfaces")}
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("health.interfaceName")}</TableCell>
                  <TableCell>IPv4</TableCell>
                  <TableCell>IPv6</TableCell>
                  <TableCell>MAC</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.interfaces
                  .filter((i) => !i.internal)
                  .map((iface) => (
                    <TableRow key={iface.name}>
                      <TableCell>{iface.name}</TableCell>
                      <TableCell>{iface.ipv4.join(", ") || "-"}</TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          sx={{ wordBreak: "break-all", maxWidth: 240 }}
                        >
                          {iface.ipv6.join(", ") || "-"}
                        </Typography>
                      </TableCell>
                      <TableCell>{iface.mac}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </Collapse>
        </>
      )}
    </Paper>
  );
}
