import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "../../i18n/index.ts";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          minHeight="60vh"
          gap={2}
          p={4}
        >
          <ErrorOutlineIcon color="error" sx={{ fontSize: 64 }} />
          <Typography variant="h5" fontWeight={600}>
            {i18n.t("errorBoundary.title")}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            textAlign="center"
            maxWidth={480}
          >
            {this.state.error?.message ??
              i18n.t("errorBoundary.fallbackMessage")}
          </Typography>
          <Button
            variant="contained"
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
          >
            {i18n.t("errorBoundary.reload")}
          </Button>
        </Box>
      );
    }
    return this.props.children;
  }
}
