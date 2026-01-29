import BugReportIcon from "@mui/icons-material/BugReport";
import CloseIcon from "@mui/icons-material/Close";
import ErrorIcon from "@mui/icons-material/Error";
import InfoIcon from "@mui/icons-material/Info";
import WarningIcon from "@mui/icons-material/Warning";
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
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";

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

const levelColors = {
  error: "#d32f2f",
  warn: "#ed6c02",
  info: "#0288d1",
  debug: "#7b1fa2",
};

const levelIcons = {
  error: ErrorIcon,
  warn: WarningIcon,
  info: InfoIcon,
  debug: BugReportIcon,
};

export const LogViewer = ({ open, onClose }: LogViewerProps) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<string[]>("error,warn,info".split(","));
  const [search, setSearch] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        level: level.join(","),
        limit: "500",
        ...(search && { search }),
      });
      const res = await fetch(`api/logs?${params}`);
      if (res.ok) {
        const data = (await res.json()) as { entries: LogEntry[] };
        setLogs(data.entries);
      }
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    } finally {
      setLoading(false);
    }
  }, [level, search]);

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
    try {
      await fetch("api/logs", { method: "DELETE" });
      setLogs([]);
    } catch (error) {
      console.error("Failed to clear logs:", error);
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
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <BugReportIcon />
        System Logs
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Auto Refresh">
          <Chip
            label={autoRefresh ? "Auto" : "Manual"}
            color={autoRefresh ? "success" : "default"}
            size="small"
            onClick={() => setAutoRefresh(!autoRefresh)}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>
        <IconButton onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent>
        <Stack spacing={2} sx={{ mb: 2 }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel>Log Level</InputLabel>
              <Select
                value={level}
                label="Log Level"
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
                            color: "white",
                          }}
                        />
                      ),
                    )}
                  </Box>
                )}
              >
                <MenuItem value="error">Error</MenuItem>
                <MenuItem value="warn">Warning</MenuItem>
                <MenuItem value="info">Info</MenuItem>
                <MenuItem value="debug">Debug</MenuItem>
              </Select>
            </FormControl>

            <TextField
              size="small"
              placeholder="Search logs..."
              value={search}
              onChange={handleSearchChange}
              sx={{ flexGrow: 1 }}
            />

            <Button variant="outlined" onClick={fetchLogs}>
              Refresh
            </Button>

            <Button variant="outlined" color="error" onClick={handleClearLogs}>
              Clear
            </Button>
          </Stack>
        </Stack>

        <Box
          sx={{
            height: 400,
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
              <Typography>Loading logs...</Typography>
            </Box>
          ) : logs.length === 0 ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
              <Typography color="text.secondary">No logs found</Typography>
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
                        color: "white",
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
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};
