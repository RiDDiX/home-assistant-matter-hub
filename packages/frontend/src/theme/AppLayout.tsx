import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Toolbar from "@mui/material/Toolbar";
import type { FC } from "react";
import { Outlet } from "react-router";
import { ErrorBoundary } from "../components/misc/ErrorBoundary.tsx";
import { FloatingLanguageSwitcher } from "../components/misc/FloatingLanguageSwitcher.tsx";
import { useWebSocketStatus } from "../contexts/WebSocketContext.tsx";
import { useAppInfo } from "../hooks/app-info.ts";
import { AppFooter } from "./AppFooter.tsx";
import { AppTopBar } from "./AppTopBar.tsx";

export const AppLayout: FC = () => {
  const { versionMismatch, frontendVersion, backendVersion } = useAppInfo();
  const { isConnected } = useWebSocketStatus();

  return (
    <Box>
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
              Reload
            </Button>
          }
        >
          Version mismatch: frontend {frontendVersion}, backend {backendVersion}
          . Please reload to get the latest UI.
        </Alert>
      )}
      {!isConnected && (
        <Alert severity="error" variant="filled" sx={{ borderRadius: 0 }}>
          Connection lost, data may be outdated. Reconnecting…
        </Alert>
      )}
      <Container sx={{ p: 2 }}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </Container>
      <AppFooter />
      <FloatingLanguageSwitcher />
    </Box>
  );
};
