import HomeIcon from "@mui/icons-material/Home";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { navigation } from "../routes.tsx";

export const NotFoundPage = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
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
      <SearchOffIcon color="disabled" sx={{ fontSize: 64 }} />
      <Typography variant="h5" fontWeight={600}>
        {t("notFound.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t("notFound.description")}
      </Typography>
      <Button
        variant="contained"
        startIcon={<HomeIcon />}
        onClick={() => navigate(navigation.dashboard)}
      >
        {t("notFound.backToDashboard")}
      </Button>
    </Box>
  );
};
