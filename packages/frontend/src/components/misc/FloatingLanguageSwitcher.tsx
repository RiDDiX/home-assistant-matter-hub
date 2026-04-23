import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import Box from "@mui/material/Box";
import ClickAwayListener from "@mui/material/ClickAwayListener";
import Divider from "@mui/material/Divider";
import Fab from "@mui/material/Fab";
import Fade from "@mui/material/Fade";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Popper from "@mui/material/Popper";
import Typography from "@mui/material/Typography";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface LanguageOption {
  code: string;
  flag: string;
  name: string;
}

const BUILT_IN_LANGUAGES: LanguageOption[] = [
  { code: "en", flag: "🇬🇧", name: "English" },
  { code: "de", flag: "🇩🇪", name: "Deutsch" },
  { code: "fr", flag: "🇫🇷", name: "Français" },
  { code: "es", flag: "🇪🇸", name: "Español" },
  { code: "it", flag: "🇮🇹", name: "Italiano" },
  { code: "zh", flag: "🇨🇳", name: "中文" },
  { code: "zh-TW", flag: "🇹🇼", name: "繁體中文" },
  { code: "th", flag: "🇹🇭", name: "ไทย" },
  { code: "sv", flag: "🇸🇪", name: "Svenska" },
  { code: "tr", flag: "🇹🇷", name: "Türkçe" },
  { code: "ru", flag: "🇷🇺", name: "Русский" },
];

const CUSTOM_LANGS_KEY = "hamh-custom-languages";

function loadCustomLanguages(): LanguageOption[] {
  try {
    const raw = localStorage.getItem(CUSTOM_LANGS_KEY);
    if (!raw) return [];
    const langs = JSON.parse(raw) as Array<{ code: string; name: string }>;
    return langs.map((l) => ({ code: l.code, flag: "🌐", name: l.name }));
  } catch {
    return [];
  }
}

const TRANSLATIONS_ISSUE_URL =
  "https://github.com/RiDDiX/home-assistant-matter-hub/issues/new?labels=translation&title=Translation+improvement";

export function FloatingLanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const languages = useMemo(
    () => [...BUILT_IN_LANGUAGES, ...loadCustomLanguages()],
    [],
  );

  const rawLang = i18n.language ?? "en";
  const currentLang = languages.some((l) => l.code === rawLang)
    ? rawLang
    : (rawLang.split("-")[0] ?? "en");

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  const handleSelect = useCallback(
    (code: string) => {
      i18n.changeLanguage(code);
      setOpen(false);
    },
    [i18n],
  );

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <ClickAwayListener onClickAway={handleClose}>
      <Box>
        <Fab
          ref={anchorRef}
          size="small"
          color="primary"
          onClick={handleToggle}
          aria-label="Change language"
          sx={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 1300,
          }}
        >
          <LanguageIcon />
        </Fab>

        <Popper
          open={open}
          anchorEl={anchorRef.current}
          placement="top-end"
          transition
          sx={{ zIndex: 1300 }}
        >
          {({ TransitionProps }) => (
            <Fade {...TransitionProps} timeout={200}>
              <Paper
                elevation={8}
                sx={{
                  mb: 1,
                  py: 0.5,
                  minWidth: 160,
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                {languages.map((lang: LanguageOption) => (
                  <Box
                    key={lang.code}
                    onClick={() => handleSelect(lang.code)}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1.5,
                      px: 2,
                      py: 1,
                      cursor: "pointer",
                      bgcolor:
                        currentLang === lang.code
                          ? "action.selected"
                          : "transparent",
                      "&:hover": {
                        bgcolor: "action.hover",
                      },
                      transition: "background-color 0.15s",
                    }}
                  >
                    <Typography
                      sx={{
                        fontSize: "1.4rem",
                        lineHeight: 1,
                        userSelect: "none",
                      }}
                    >
                      {lang.flag}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: currentLang === lang.code ? 600 : 400 }}
                    >
                      {lang.name}
                    </Typography>
                  </Box>
                ))}

                <Divider />
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 0.75,
                    px: 2,
                    py: 1,
                  }}
                >
                  <InfoOutlinedIcon
                    sx={{ fontSize: 14, mt: 0.25, color: "text.secondary" }}
                  />
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ lineHeight: 1.4 }}
                  >
                    {t("languageSwitcher.disclaimer")}{" "}
                    <Link
                      href={TRANSLATIONS_ISSUE_URL}
                      target="_blank"
                      rel="noopener"
                      sx={{ fontSize: "inherit" }}
                    >
                      {t("languageSwitcher.contribute")}
                    </Link>
                  </Typography>
                </Box>
              </Paper>
            </Fade>
          )}
        </Popper>
      </Box>
    </ClickAwayListener>
  );
}
