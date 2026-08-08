import AccountTreeIcon from "@mui/icons-material/AccountTree";
import BugReportIcon from "@mui/icons-material/BugReport";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import DevicesIcon from "@mui/icons-material/Devices";
import ExtensionIcon from "@mui/icons-material/Extension";
import HomeIcon from "@mui/icons-material/Home";
import HubIcon from "@mui/icons-material/Hub";
import LabelIcon from "@mui/icons-material/Label";
import LightModeIcon from "@mui/icons-material/LightMode";
import LockIcon from "@mui/icons-material/Lock";
import MenuIcon from "@mui/icons-material/Menu";
import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import RouterIcon from "@mui/icons-material/Router";
import SettingsIcon from "@mui/icons-material/Settings";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import { useColorScheme } from "@mui/material/styles";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { LogViewer } from "../components/logs/LogViewer.tsx";
import { StatusIndicator } from "../components/status/StatusIndicator.tsx";
import { navigation } from "../routes.tsx";
import { AppLogo } from "./AppLogo.tsx";

interface NavItem {
  label: string;
  icon: ReactNode;
  to?: string;
  onClick?: () => void;
}

export const AppTopBar = () => {
  const isLargeScreen = useMediaQuery("(min-width:600px)");
  const { mode, setMode } = useColorScheme();
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path?: string) => {
    if (!path) return false;
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  const toggleColorMode = () => {
    setMode(mode === "dark" ? "light" : "dark");
  };

  const { t } = useTranslation();

  const navItems: NavItem[] = [
    {
      label: t("dashboard.title"),
      icon: <HomeIcon />,
      to: navigation.dashboard,
    },
    { label: t("nav.bridges"), icon: <HubIcon />, to: navigation.bridges },
    { label: t("nav.devices"), icon: <DevicesIcon />, to: navigation.devices },
    {
      label: t("nav.standaloneDevices", "Standalone Devices"),
      icon: <RouterIcon />,
      to: navigation.standaloneDevices,
    },
    {
      label: t("nav.networkMap"),
      icon: <AccountTreeIcon />,
      to: navigation.networkMap,
    },
    {
      label: t("nav.startupOrder"),
      icon: <RocketLaunchIcon />,
      to: navigation.startup,
    },
    {
      label: t("nav.lockCredentials"),
      icon: <LockIcon />,
      to: navigation.lockCredentials,
    },
    {
      label: t("nav.filterReference"),
      icon: <LabelIcon />,
      to: navigation.labels,
    },
    {
      label: "Plugins",
      icon: <ExtensionIcon />,
      to: navigation.plugins,
    },
    {
      label: t("nav.settings"),
      icon: <SettingsIcon />,
      to: navigation.settings,
    },
    {
      label: mode === "dark" ? t("nav.lightMode") : t("nav.darkMode"),
      icon: mode === "dark" ? <LightModeIcon /> : <DarkModeIcon />,
      onClick: toggleColorMode,
    },
    {
      label: t("nav.systemLogs"),
      icon: <BugReportIcon />,
      onClick: () => setLogViewerOpen(true),
    },
    {
      label: t("nav.health"),
      icon: <MonitorHeartIcon />,
      to: navigation.health,
    },
  ];

  const handleDrawerItemClick = (item: NavItem) => {
    setDrawerOpen(false);
    if (item.onClick) {
      item.onClick();
    } else if (item.to) {
      navigate(item.to);
    }
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
            {isLargeScreen ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                {navItems.map((item) =>
                  item.to ? (
                    <Tooltip title={item.label} key={item.label}>
                      <IconButton
                        component={Link}
                        to={item.to}
                        sx={{
                          color: "inherit",
                          bgcolor: isActive(item.to)
                            ? "rgba(255,255,255,0.15)"
                            : "transparent",
                          borderRadius: 1,
                        }}
                      >
                        {item.icon}
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title={item.label} key={item.label}>
                      <IconButton
                        onClick={item.onClick}
                        sx={{ color: "inherit" }}
                      >
                        {item.icon}
                      </IconButton>
                    </Tooltip>
                  ),
                )}
                <StatusIndicator />
              </Box>
            ) : (
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                <StatusIndicator />
                <IconButton
                  onClick={() => setDrawerOpen(true)}
                  sx={{ color: "inherit" }}
                >
                  <MenuIcon />
                </IconButton>
              </Box>
            )}
          </Container>
        </Toolbar>
      </AppBar>
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        <List sx={{ width: 250 }}>
          {navItems.map((item) => (
            <ListItemButton
              key={item.label}
              selected={isActive(item.to)}
              onClick={() => handleDrawerItemClick(item)}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>
      <LogViewer open={logViewerOpen} onClose={() => setLogViewerOpen(false)} />
    </Box>
  );
};
