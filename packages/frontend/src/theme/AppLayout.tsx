import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Toolbar from "@mui/material/Toolbar";
import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import { ErrorBoundary } from "../components/misc/ErrorBoundary.tsx";
import { useWebSocketStatus } from "../contexts/WebSocketContext.tsx";
import { useAppInfo } from "../hooks/app-info.ts";
import { AppFooter } from "./AppFooter.tsx";
import { AppTopBar, NAV_WIDTH } from "./AppTopBar.tsx";

export const AppLayout: FC = () => {
  const { versionMismatch, frontendVersion, backendVersion } = useAppInfo();
  const { isConnected, closedOnce } = useWebSocketStatus();
  const { t } = useTranslation();

  return (
    <Box
      sx={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        ml: { md: `${NAV_WIDTH}px` },
      }}
    >
      <AppTopBar />
      <Toolbar />
      {versionMismatch && (
        <Alert
          severity="warning"
          variant="filled"
          sx={{ borderRadius: 0 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => window.location.reload()}
            >
              {t("common.reload")}
            </Button>
          }
        >
          {t("app.versionMismatch", {
            frontend: frontendVersion,
            backend: backendVersion,
          })}
        </Alert>
      )}
      {closedOnce && !isConnected && (
        <Alert severity="error" variant="filled" sx={{ borderRadius: 0 }}>
          {t("app.connectionLost")}
        </Alert>
      )}
      <Container component="main" sx={{ p: 2, flexGrow: 1 }}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </Container>
      <AppFooter />
    </Box>
  );
};
