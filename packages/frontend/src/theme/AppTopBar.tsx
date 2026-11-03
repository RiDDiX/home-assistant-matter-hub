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
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import { alpha, type Theme, useColorScheme } from "@mui/material/styles";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { LogViewer } from "../components/logs/LogViewer.tsx";
import { StatusIndicator } from "../components/status/StatusIndicator.tsx";
import { navigation } from "../routes.tsx";
import { AppLogo } from "./AppLogo.tsx";

export const NAV_WIDTH = 240;

interface NavItem {
  label: string;
  icon: ReactNode;
  to: string;
}

export const AppTopBar = () => {
  const isDesktop = useMediaQuery((theme: Theme) => theme.breakpoints.up("md"));
  // colorScheme resolves "system" to the scheme actually shown
  const { colorScheme, setMode } = useColorScheme();
  const isDark = colorScheme === "dark";
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const { t } = useTranslation();

  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  const navGroups: NavItem[][] = [
    [
      {
        label: t("dashboard.title"),
        icon: <HomeIcon />,
        to: navigation.dashboard,
      },
    ],
    [
      { label: t("nav.bridges"), icon: <HubIcon />, to: navigation.bridges },
      {
        label: t("nav.devices"),
        icon: <DevicesIcon />,
        to: navigation.devices,
      },
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
    ],
    [
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
        label: t("nav.plugins", "Plugins"),
        icon: <ExtensionIcon />,
        to: navigation.plugins,
      },
      {
        label: t("nav.health"),
        icon: <MonitorHeartIcon />,
        to: navigation.health,
      },
      {
        label: t("nav.settings"),
        icon: <SettingsIcon />,
        to: navigation.settings,
      },
    ],
  ];

  const themeLabel = isDark ? t("nav.lightMode") : t("nav.darkMode");
  const logsLabel = t("nav.systemLogs");

  const navList = (
    <Box component="nav" aria-label={t("nav.main", "Main")}>
      {navGroups.map((group, idx) => (
        <Fragment key={group[0].to}>
          {idx > 0 && <Divider sx={{ my: 1, mx: 2 }} />}
          <List disablePadding sx={{ px: 1 }}>
            {group.map((item) => {
              const active = isActive(item.to);
              return (
                <ListItemButton
                  key={item.to}
                  component={Link}
                  to={item.to}
                  selected={active}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setDrawerOpen(false)}
                  sx={(theme) => ({
                    borderRadius: 1,
                    minHeight: 44,
                    mb: 0.25,
                    color: "text.secondary",
                    "& .MuiListItemIcon-root": {
                      color: "inherit",
                      minWidth: 40,
                    },
                    "&.Mui-selected, &.Mui-selected:hover": {
                      color: "primary.main",
                      bgcolor: alpha(theme.palette.primary.main, 0.12),
                    },
                  })}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    slotProps={{
                      primary: {
                        variant: "body2",
                        fontWeight: active ? 600 : 500,
                      },
                    }}
                  />
                </ListItemButton>
              );
            })}
          </List>
        </Fragment>
      ))}
    </Box>
  );

  const actionSx = { color: "text.secondary" };

  return (
    <>
      <AppBar
        position="fixed"
        // above the sidebar on desktop, below the modal drawer on mobile
        sx={(theme) => ({ zIndex: { md: theme.zIndex.drawer + 1 } })}
      >
        <Toolbar sx={{ gap: 0.5 }}>
          {!isDesktop && (
            <IconButton
              edge="start"
              size="large"
              aria-label={t("nav.menu", "Menu")}
              aria-expanded={drawerOpen}
              aria-controls="app-nav-drawer"
              onClick={() => setDrawerOpen(true)}
              sx={actionSx}
            >
              <MenuIcon />
            </IconButton>
          )}
          <AppLogo />
          <StatusIndicator />
          <Tooltip title={logsLabel}>
            <IconButton
              aria-label={logsLabel}
              onClick={() => setLogViewerOpen(true)}
              sx={actionSx}
            >
              <BugReportIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title={themeLabel}>
            <IconButton
              aria-label={themeLabel}
              onClick={() => setMode(isDark ? "light" : "dark")}
              edge="end"
              sx={actionSx}
            >
              {isDark ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Drawer
        id="app-nav-drawer"
        variant={isDesktop ? "permanent" : "temporary"}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sx={{
          width: { md: NAV_WIDTH },
          flexShrink: 0,
          "& .MuiDrawer-paper": {
            width: NAV_WIDTH,
            boxSizing: "border-box",
            backgroundImage: "none",
          },
        }}
      >
        {isDesktop && <Toolbar />}
        <Box sx={{ py: 1, overflowY: "auto" }}>{navList}</Box>
      </Drawer>
      <LogViewer open={logViewerOpen} onClose={() => setLogViewerOpen(false)} />
    </>
  );
};
