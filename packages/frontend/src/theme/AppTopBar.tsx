import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import { Link } from "react-router";
import { navigation } from "../routes.tsx";
import { AppLogo } from "./AppLogo.tsx";

export const AppTopBar = () => {
  const isLargeScreen = useMediaQuery("(min-width:600px)");

  return (
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
            <Tooltip title="Health Dashboard">
              <IconButton
                component={Link}
                to={navigation.health}
                sx={{ color: "inherit" }}
              >
                <MonitorHeartIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </Container>
      </Toolbar>
    </AppBar>
  );
};
