import LanguageIcon from "@mui/icons-material/Language";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import type { SxProps, Theme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CUSTOM_LANGS_KEY, LANGUAGES } from "../../i18n/index.ts";

interface LanguageOption {
  code: string;
  name: string;
}

function loadCustomLanguages(): LanguageOption[] {
  try {
    const raw = localStorage.getItem(CUSTOM_LANGS_KEY);
    if (!raw) return [];
    const langs = JSON.parse(raw) as LanguageOption[];
    return langs.map((l) => ({ code: l.code, name: l.name }));
  } catch {
    return [];
  }
}

const TRANSLATIONS_ISSUE_URL =
  "https://github.com/RiDDiX/home-assistant-matter-hub/issues/new?labels=translation&title=Translation+improvement";

export function LanguageSwitcher({ sx }: { sx?: SxProps<Theme> }) {
  const { t, i18n } = useTranslation();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = anchorEl !== null;
  const close = () => setAnchorEl(null);

  // read on every render so languages added in the editor show up
  const languages = [...LANGUAGES, ...loadCustomLanguages()];
  const rawLang = i18n.language ?? "en";
  const currentLang = languages.some((l) => l.code === rawLang)
    ? rawLang
    : rawLang.split("-")[0];

  return (
    <>
      <ListItemButton
        id="language-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "language-menu" : undefined}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={sx}
      >
        <ListItemIcon>
          <LanguageIcon />
        </ListItemIcon>
        <ListItemText
          primary={t("settings.language")}
          secondary={languages.find((l) => l.code === currentLang)?.name}
          slotProps={{ primary: { variant: "body2", fontWeight: 500 } }}
        />
      </ListItemButton>
      <Menu
        id="language-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: "top", horizontal: "left" }}
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ list: { "aria-labelledby": "language-button" } }}
      >
        {languages.map((lang) => (
          <MenuItem
            key={lang.code}
            lang={lang.code}
            selected={lang.code === currentLang}
            onClick={() => {
              i18n.changeLanguage(lang.code);
              close();
            }}
          >
            {lang.name}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          component="a"
          href={TRANSLATIONS_ISSUE_URL}
          target="_blank"
          rel="noopener"
          onClick={close}
          sx={{ whiteSpace: "normal", maxWidth: 260 }}
        >
          <Typography variant="caption" color="text.secondary">
            {t("languageSwitcher.disclaimer")}{" "}
            <Box component="span" sx={{ color: "primary.main" }}>
              {t("languageSwitcher.contribute")}
            </Box>
          </Typography>
        </MenuItem>
      </Menu>
    </>
  );
}
