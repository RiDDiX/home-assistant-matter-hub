import BugReportIcon from "@mui/icons-material/BugReport";
import CampaignIcon from "@mui/icons-material/Campaign";
import CloseIcon from "@mui/icons-material/Close";
import ErrorIcon from "@mui/icons-material/Error";
import InfoIcon from "@mui/icons-material/Info";
import ReportIcon from "@mui/icons-material/Report";
import WarningIcon from "@mui/icons-material/Warning";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select, { type SelectChangeEvent } from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import { useTheme } from "@mui/material/styles";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../misc/ConfirmDialog.tsx";
import { useNotifications } from "../notifications/use-notifications.ts";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

interface LogViewerProps {
  open: boolean;
  onClose: () => void;
}

// matter.js traffic lands in the buffer with its own levels, notice included
const levelIcons = {
  fatal: ReportIcon,
  error: ErrorIcon,
  warn: WarningIcon,
  notice: CampaignIcon,
  info: InfoIcon,
  debug: BugReportIcon,
};

export const LogViewer = ({ open, onClose }: LogViewerProps) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const notifications = useNotifications();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const levelColors = useMemo(
    () => ({
      fatal: theme.palette.error.dark,
      error: theme.palette.error.main,
      warn: theme.palette.warning.main,
      notice: theme.palette.primary.main,
      info: theme.palette.info.main,
      debug: theme.palette.secondary.main,
    }),
    [theme],
  );
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [level, setLevel] = useState<string[]>([
    "fatal",
    "error",
    "warn",
    "notice",
    "info",
  ]);
  const [search, setSearch] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const query = new URLSearchParams({
    level: level.join(","),
    limit: "500",
    ...(search && { search }),
  }).toString();
  // only a filter change drops older answers, a slow poll still lands
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`api/logs?${query}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { entries: LogEntry[] };
      if (query !== queryRef.current) return;
      setLogs(data.entries);
      setFetchError(false);
    } catch {
      // polled every 5 s, so an inline alert instead of a toast per try
      if (query === queryRef.current) setFetchError(true);
    } finally {
      if (query === queryRef.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (open) {
      fetchLogs();
    }
  }, [open, fetchLogs]);

  useEffect(() => {
    if (!autoRefresh || !open) return;

    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, open, fetchLogs]);

  const handleLevelChange = (event: SelectChangeEvent<string[]>) => {
    setLevel(
      Array.isArray(event.target.value)
        ? event.target.value
        : [event.target.value],
    );
  };

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(event.target.value);
  };

  const handleClearLogs = async () => {
    setConfirmClear(false);
    try {
      const res = await fetch("api/logs", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLogs([]);
      notifications.show({ message: t("logs.cleared"), severity: "success" });
    } catch {
      notifications.show({ message: t("logs.clearFailed"), severity: "error" });
    }
  };

  const getLevelIcon = (level: string) => {
    const Icon = levelIcons[level as keyof typeof levelIcons] || InfoIcon;
    return (
      <Icon
        sx={{
          fontSize: 16,
          color: levelColors[level as keyof typeof levelColors],
        }}
      />
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      fullScreen={fullScreen}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <BugReportIcon />
        {t("logs.title")}
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title={t("logs.autoRefresh")}>
          <Chip
            label={autoRefresh ? t("logs.auto") : t("logs.manual")}
            color={autoRefresh ? "success" : "default"}
            size="small"
            onClick={() => setAutoRefresh(!autoRefresh)}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>
        <IconButton onClick={onClose} aria-label={t("common.close")}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent>
        {/* pt keeps the select label clear of the content's clipping edge */}
        <Stack spacing={2} sx={{ mb: 2, pt: 1.5 }}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            alignItems={{ sm: "center" }}
          >
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel>{t("logs.logLevel")}</InputLabel>
              <Select
                value={level}
                label={t("logs.logLevel")}
                onChange={handleLevelChange}
                multiple
                renderValue={(selected) => (
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                    {(Array.isArray(selected) ? selected : [selected]).map(
                      (value) => (
                        <Chip
                          key={value}
                          label={value.toUpperCase()}
                          size="small"
                          sx={{
                            backgroundColor:
                              levelColors[value as keyof typeof levelColors],
                            color: theme.palette.getContrastText(
                              levelColors[value as keyof typeof levelColors] ??
                                theme.palette.grey[500],
                            ),
                          }}
                        />
                      ),
                    )}
                  </Box>
                )}
              >
                <MenuItem value="fatal">{t("logs.fatal")}</MenuItem>
                <MenuItem value="error">{t("logs.error")}</MenuItem>
                <MenuItem value="warn">{t("logs.warning")}</MenuItem>
                <MenuItem value="notice">{t("logs.notice")}</MenuItem>
                <MenuItem value="info">{t("logs.info")}</MenuItem>
                <MenuItem value="debug">{t("logs.debug")}</MenuItem>
              </Select>
            </FormControl>

            <TextField
              size="small"
              placeholder={t("logs.searchPlaceholder")}
              value={search}
              onChange={handleSearchChange}
              sx={{ flexGrow: 1 }}
            />

            <Button variant="outlined" onClick={fetchLogs}>
              {t("common.refresh")}
            </Button>

            <Button
              variant="outlined"
              color="error"
              onClick={() => setConfirmClear(true)}
            >
              {t("common.delete")}
            </Button>
          </Stack>
          {fetchError && (
            <Alert severity="error">{t("logs.fetchFailed")}</Alert>
          )}
        </Stack>

        <Box
          sx={{
            height: fullScreen ? "auto" : 400,
            minHeight: 200,
            overflow: "auto",
            backgroundColor: "background.paper",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            p: 1,
          }}
        >
          {loading ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
              <Typography>{t("common.loading")}...</Typography>
            </Box>
          ) : logs.length === 0 ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
              <Typography color="text.secondary">
                {t("logs.noResults")}
              </Typography>
            </Box>
          ) : (
            <Stack spacing={1}>
              {logs.map((log, index) => (
                <Box
                  key={`${log.timestamp}-${log.level}-${index}`}
                  sx={{
                    p: 1,
                    borderRadius: 1,
                    backgroundColor: "action.hover",
                    fontFamily: "monospace",
                    fontSize: "0.875rem",
                    wordBreak: "break-all",
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      mb: 0.5,
                    }}
                  >
                    {getLevelIcon(log.level)}
                    <Typography variant="caption" color="text.secondary">
                      {new Date(log.timestamp).toLocaleString()}
                    </Typography>
                    <Chip
                      label={log.level.toUpperCase()}
                      size="small"
                      sx={{
                        backgroundColor:
                          levelColors[log.level as keyof typeof levelColors],
                        color: theme.palette.getContrastText(
                          levelColors[log.level as keyof typeof levelColors] ??
                            theme.palette.grey[500],
                        ),
                        fontSize: "0.7rem",
                        height: 20,
                      }}
                    />
                  </Box>
                  <Typography sx={{ ml: 3 }}>{log.message}</Typography>
                  {log.context && (
                    <Typography
                      sx={{
                        ml: 3,
                        color: "text.secondary",
                        fontSize: "0.8rem",
                      }}
                    >
                      {JSON.stringify(log.context, null, 2)}
                    </Typography>
                  )}
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogActions>

      <ConfirmDialog
        open={confirmClear}
        title={t("logs.clearConfirmTitle")}
        message={t("logs.clearConfirmMessage")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={handleClearLogs}
        onCancel={() => setConfirmClear(false)}
      />
    </Dialog>
  );
};
