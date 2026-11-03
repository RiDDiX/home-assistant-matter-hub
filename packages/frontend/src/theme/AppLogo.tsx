import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { capitalize } from "@mui/material/utils";
import { Link } from "react-router";
import SvgLogo from "../assets/hamh-logo.svg?react";
import { useAppInfo } from "../hooks/app-info.ts";
import { navigation } from "../routes.tsx";

export const AppLogo = () => {
  const appInfo = useAppInfo();
  const name = appInfo.name.split("-").map(capitalize).join("-");

  return (
    <Box
      component={Link}
      to={navigation.dashboard}
      aria-label={name}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexGrow: 1,
        minWidth: 0,
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <SvgLogo style={{ height: "32px", flexShrink: 0 }} />
      <Typography
        variant="subtitle1"
        component="span"
        noWrap
        sx={{ fontWeight: 600, display: { xs: "none", sm: "block" } }}
      >
        {name}
      </Typography>
      <Typography
        variant="caption"
        component="span"
        noWrap
        sx={{ color: "text.secondary", display: { xs: "none", md: "block" } }}
      >
        {appInfo.version}
      </Typography>
    </Box>
  );
};
