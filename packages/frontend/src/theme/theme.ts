import { createTheme } from "@mui/material/styles";

// Every *.main passes WCAG AA as text on paper and background (light >= 4.5, dark >= 7).
export const appTheme = createTheme({
  colorSchemes: {
    light: {
      palette: {
        primary: { main: "#1565C0", light: "#1E88E5", dark: "#0D47A1" },
        secondary: { main: "#7B1FA2", light: "#9C27B0", dark: "#4A148C" },
        success: { main: "#2E7D32" },
        warning: { main: "#B45309" },
        error: { main: "#C62828" },
        info: { main: "#0369A1" },
        background: { default: "#F4F6F9", paper: "#FFFFFF" },
        text: { primary: "#111827", secondary: "#4B5563" },
        divider: "#DFE3E9",
      },
    },
    dark: {
      palette: {
        primary: { main: "#90CAF9", light: "#E3F2FD", dark: "#42A5F5" },
        secondary: { main: "#CE93D8", light: "#F3E5F5", dark: "#AB47BC" },
        success: { main: "#66BB6A" },
        warning: { main: "#FFB74D" },
        error: { main: "#F28B82" },
        info: { main: "#4FC3F7" },
        background: { default: "#0F1217", paper: "#171B22" },
        text: { primary: "#E6E9EF", secondary: "#A3ACB9" },
        divider: "#2A303A",
      },
    },
  },
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
    h1: { fontSize: "2.25rem", fontWeight: 700 },
    h2: { fontSize: "1.875rem", fontWeight: 700 },
    h3: { fontSize: "1.5rem", fontWeight: 700 },
    h4: { fontSize: "1.5rem", fontWeight: 700 },
    h5: { fontSize: "1.25rem", fontWeight: 700 },
    h6: { fontSize: "1rem", fontWeight: 500 },
    subtitle2: { fontWeight: 500 },
    button: { textTransform: "none", fontWeight: 500 },
  },
  shape: { borderRadius: 8 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        // keeps scrolled-to fields and validation bubbles below the fixed bar
        html: { scrollPaddingTop: 80 },
        "@media (prefers-reduced-motion: reduce)": {
          // transitions only, loading spinners must keep turning
          "*, *::before, *::after": {
            transitionDuration: "0.01ms !important",
            scrollBehavior: "auto !important",
          },
        },
      },
    },
    MuiButtonBase: {
      styleOverrides: {
        root: ({ theme }) => ({
          "&.Mui-focusVisible": {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: 2,
          },
        }),
      },
    },
    // these sit in clipping containers, draw the ring inside
    MuiCardActionArea: {
      styleOverrides: { root: { "&.Mui-focusVisible": { outlineOffset: -2 } } },
    },
    MuiListItemButton: {
      styleOverrides: { root: { "&.Mui-focusVisible": { outlineOffset: -2 } } },
    },
    MuiMenuItem: {
      styleOverrides: { root: { "&.Mui-focusVisible": { outlineOffset: -2 } } },
    },
    MuiTab: {
      styleOverrides: { root: { "&.Mui-focusVisible": { outlineOffset: -2 } } },
    },
    MuiToggleButton: {
      styleOverrides: { root: { "&.Mui-focusVisible": { outlineOffset: -2 } } },
    },
    MuiAccordionSummary: {
      styleOverrides: { root: { "&.Mui-focusVisible": { outlineOffset: -2 } } },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: { "&.Mui-focusVisible": { outlineOffset: -2 } },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
    },
    MuiCard: {
      defaultProps: { variant: "outlined" },
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 12,
          transition: theme.transitions.create(["border-color", "box-shadow"], {
            duration: theme.transitions.duration.shorter,
          }),
          // only clickable cards react to hover
          "&:has(.MuiCardActionArea-root):hover": {
            borderColor: theme.palette.primary.main,
            boxShadow:
              theme.palette.mode === "dark"
                ? "0 2px 8px rgba(0,0,0,0.5)"
                : "0 2px 8px rgba(17,24,39,0.08)",
          },
        }),
      },
    },
    MuiAccordion: {
      defaultProps: { variant: "outlined", disableGutters: true },
      styleOverrides: { root: { "&::before": { display: "none" } } },
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 12 } },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 500 } },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: "inherit" },
      styleOverrides: {
        root: ({ theme }) => ({
          backgroundImage: "none",
          backgroundColor: theme.palette.background.paper,
          color: theme.palette.text.primary,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }),
      },
    },
  },
});
