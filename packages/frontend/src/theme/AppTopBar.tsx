import BugReportIcon from "@mui/icons-material/BugReport";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import { useColorScheme } from "@mui/material/styles";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useState } from "react";
import { Link } from "react-router";
import { LogViewer } from "../components/logs/LogViewer.tsx";
import { StatusIndicator } from "../components/status/StatusIndicator.tsx";
import { navigation } from "../routes.tsx";
import { AppLogo } from "./AppLogo.tsx";

export const AppTopBar = () => {
  const isLargeScreen = useMediaQuery("(min-width:600px)");
  const { mode, setMode } = useColorScheme();
  const [logViewerOpen, setLogViewerOpen] = useState(false);

  const toggleColorMode = () => {
    setMode(mode === "dark" ? "light" : "dark");
  };

  return (
    <Box>
      <AppBar sx={{ height: "72px" }}>
        <Toolbar
          sx={{ paddingLeft: "0 !important", paddingRight: "0 !important" }}
        >
          <Container
            sx={{
              padding: 2,
              height: "100%",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <AppLogo large={isLargeScreen} />
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Tooltip title={mode === "dark" ? "Light Mode" : "Dark Mode"}>
                <IconButton onClick={toggleColorMode} sx={{ color: "inherit" }}>
                  {mode === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
                </IconButton>
              </Tooltip>
              <Tooltip title="System Logs">
                <IconButton
                  onClick={() => setLogViewerOpen(true)}
                  sx={{ color: "inherit" }}
                >
                  <BugReportIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Health Dashboard">
                <IconButton
                  component={Link}
                  to={navigation.health}
                  sx={{ color: "inherit" }}
                >
                  <MonitorHeartIcon />
                </IconButton>
              </Tooltip>
              <StatusIndicator />
            </Box>
          </Container>
        </Toolbar>
      </AppBar>
      <LogViewer open={logViewerOpen} onClose={() => setLogViewerOpen(false)} />
    </Box>
  );
};
