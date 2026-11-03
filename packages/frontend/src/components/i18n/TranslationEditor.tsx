import AddIcon from "@mui/icons-material/Add";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DownloadIcon from "@mui/icons-material/Download";
import RestoreIcon from "@mui/icons-material/Restore";
import SearchIcon from "@mui/icons-material/Search";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  applyTranslationOverrides,
  bundledResources,
  CUSTOM_LANGS_KEY,
  flattenObject,
  LANGUAGES,
  STORAGE_KEY,
  unflattenObject,
} from "../../i18n/index.ts";
import en from "../../i18n/locales/en.json";
import { ConfirmDialog } from "../misc/ConfirmDialog.tsx";
import { copyText } from "../misc/copy-text.ts";
import { useNotifications } from "../notifications/use-notifications.ts";

interface FlatEntry {
  key: string;
  section: string;
  enValue: string;
  currentValue: string;
  isOverridden: boolean;
}

function loadOverrides(lang: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, Record<string, string>>;
    return all[lang] ?? {};
  } catch {
    return {};
  }
}

function saveOverrides(lang: string, overrides: Record<string, string>) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all = raw
      ? (JSON.parse(raw) as Record<string, Record<string, string>>)
      : {};
    if (Object.keys(overrides).length === 0) {
      delete all[lang];
    } else {
      all[lang] = overrides;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore storage errors
  }
}

interface CustomLang {
  code: string;
  name: string;
}

function loadCustomLanguages(): CustomLang[] {
  try {
    const raw = localStorage.getItem(CUSTOM_LANGS_KEY);
    return raw ? (JSON.parse(raw) as CustomLang[]) : [];
  } catch {
    return [];
  }
}

function saveCustomLanguages(langs: CustomLang[]) {
  localStorage.setItem(CUSTOM_LANGS_KEY, JSON.stringify(langs));
}

const EDITABLE_LANGUAGES = LANGUAGES.filter((l) => l.code !== "en");

export function TranslationEditor() {
  const { t, i18n } = useTranslation();
  const notifications = useNotifications();
  const [customLangs, setCustomLangs] =
    useState<CustomLang[]>(loadCustomLanguages);
  const allLanguages = useMemo(
    () => [...EDITABLE_LANGUAGES, ...customLangs],
    [customLangs],
  );
  const [editLang, setEditLang] = useState(() => {
    const codes = allLanguages.map((l) => l.code);
    const lang = i18n.language ?? "en";
    const base = lang.split("-")[0];
    if (codes.includes(lang)) return lang;
    return codes.includes(base) ? base : "de";
  });
  const [search, setSearch] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>(() =>
    loadOverrides(editLang),
  );
  const [filterMode, setFilterMode] = useState<"all" | "missing" | "edited">(
    "all",
  );
  const [showAddLang, setShowAddLang] = useState(false);
  const [newLangCode, setNewLangCode] = useState("");
  const [newLangName, setNewLangName] = useState("");
  const [addLangError, setAddLangError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const isCustomLang = useCallback(
    (code: string) => customLangs.some((l) => l.code === code),
    [customLangs],
  );

  const enFlat = useMemo(
    () => flattenObject(en as Record<string, unknown>),
    [],
  );

  // the live bundle already holds the local edits, compare against the shipped one
  const currentTranslations = useMemo(
    () => flattenObject(bundledResources[editLang]?.translation ?? {}),
    [editLang],
  );

  const entries: FlatEntry[] = useMemo(() => {
    const keys = Object.keys(enFlat);
    return keys.map((key) => ({
      key,
      section: key.split(".")[0],
      enValue: enFlat[key],
      currentValue: overrides[key] ?? currentTranslations[key] ?? "",
      isOverridden: key in overrides,
    }));
  }, [enFlat, currentTranslations, overrides]);

  const filteredEntries = useMemo(() => {
    let filtered = entries;
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (e) =>
          e.key.toLowerCase().includes(q) ||
          e.enValue.toLowerCase().includes(q) ||
          e.currentValue.toLowerCase().includes(q),
      );
    }
    if (filterMode === "missing") {
      filtered = filtered.filter((e) => !e.currentValue);
    } else if (filterMode === "edited") {
      filtered = filtered.filter((e) => e.isOverridden);
    }
    return filtered;
  }, [entries, search, filterMode]);

  const sections = useMemo(
    () => [...new Set(filteredEntries.map((e) => e.section))],
    [filteredEntries],
  );

  const totalKeys = Object.keys(enFlat).length;
  const translatedKeys = entries.filter((e) => e.currentValue).length;
  const overriddenKeys = Object.keys(overrides).length;
  const progress = totalKeys > 0 ? (translatedKeys / totalKeys) * 100 : 0;

  useEffect(() => {
    setOverrides(loadOverrides(editLang));
  }, [editLang]);

  const applyOverrides = useCallback(
    (newOverrides: Record<string, string>) => {
      setOverrides(newOverrides);
      saveOverrides(editLang, newOverrides);

      // every bundle swap re-renders the whole app, so wait for a typing pause
      clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(
        () => applyTranslationOverrides(editLang, newOverrides),
        300,
      );
    },
    [editLang],
  );

  const handleChange = useCallback(
    (key: string, value: string) => {
      const next = { ...overrides, [key]: value };
      if (!value) {
        delete next[key];
      }
      applyOverrides(next);
    },
    [overrides, applyOverrides],
  );

  const handleResetKey = useCallback(
    (key: string) => {
      const next = { ...overrides };
      delete next[key];
      applyOverrides(next);
    },
    [overrides, applyOverrides],
  );

  const handleResetAll = useCallback(() => {
    applyOverrides({});
  }, [applyOverrides]);

  const buildJson = useCallback(() => {
    const merged: Record<string, string> = {};
    for (const key of Object.keys(enFlat)) {
      const value = overrides[key] ?? currentTranslations[key];
      // an empty string would replace the English fallback
      if (value) merged[key] = value;
    }
    return JSON.stringify(unflattenObject(merged), null, 2);
  }, [enFlat, currentTranslations, overrides]);

  const handleExport = useCallback(() => {
    const json = buildJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${editLang}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [buildJson, editLang]);

  const handleCopyJson = useCallback(async () => {
    const ok = await copyText(buildJson());
    notifications.show(
      ok
        ? { message: t("translationEditor.copied"), severity: "success" }
        : { message: t("common.copyFailed"), severity: "error" },
    );
  }, [buildJson, notifications, t]);

  const handleAddLanguage = useCallback(() => {
    const code = newLangCode.trim().toLowerCase();
    const name = newLangName.trim();
    if (!code) {
      setAddLangError(t("translationEditor.codeRequired"));
      return;
    }
    if (!name) {
      setAddLangError(t("translationEditor.nameRequired"));
      return;
    }
    if (
      LANGUAGES.some((l) => l.code === code) ||
      customLangs.some((l) => l.code === code)
    ) {
      setAddLangError(t("translationEditor.languageExists"));
      return;
    }
    const updated = [...customLangs, { code, name }];
    setCustomLangs(updated);
    saveCustomLanguages(updated);
    i18n.addResourceBundle(code, "translation", {}, true, true);
    setEditLang(code);
    setShowAddLang(false);
    setNewLangCode("");
    setNewLangName("");
    setAddLangError("");
  }, [newLangCode, newLangName, customLangs, i18n, t]);

  const handleRemoveLanguage = useCallback(() => {
    setConfirmRemove(false);
    if (!isCustomLang(editLang)) return;
    const updated = customLangs.filter((l) => l.code !== editLang);
    setCustomLangs(updated);
    saveCustomLanguages(updated);
    saveOverrides(editLang, {});
    if (i18n.language === editLang) i18n.changeLanguage("en");
    setEditLang(EDITABLE_LANGUAGES[0].code);
  }, [editLang, customLangs, isCustomLang, i18n]);

  const handleImportJson = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result as string);
          if (typeof parsed !== "object" || parsed === null) throw new Error();
          const flat = flattenObject(parsed as Record<string, unknown>);
          const validKeys = new Set(Object.keys(enFlat));
          const imported: Record<string, string> = {};
          let count = 0;
          for (const [k, v] of Object.entries(flat)) {
            if (validKeys.has(k) && v) {
              imported[k] = v;
              count++;
            }
          }
          applyOverrides({ ...overrides, ...imported });
          notifications.show({
            message: t("translationEditor.importSuccess", { count }),
            severity: "success",
          });
        } catch {
          notifications.show({
            message: t("translationEditor.importFailed"),
            severity: "error",
          });
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [enFlat, overrides, applyOverrides, notifications, t]);

  return (
    <Box>
      <Box display="flex" alignItems="center" mb={2} gap={1}>
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel id="translation-edit-lang">
            {t("translationEditor.editLanguage")}
          </InputLabel>
          <Select
            labelId="translation-edit-lang"
            value={editLang}
            label={t("translationEditor.editLanguage")}
            onChange={(_e: { target: { value: string } }) =>
              setEditLang(_e.target.value)
            }
          >
            {allLanguages.map((l) => (
              <MenuItem key={l.code} value={l.code}>
                <ListItemText primary={l.name} />
                {isCustomLang(l.code) && (
                  <ListItemIcon sx={{ minWidth: "auto", ml: 1 }}>
                    <DeleteOutlineIcon fontSize="small" color="disabled" />
                  </ListItemIcon>
                )}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Tooltip title={t("translationEditor.addLanguage")}>
          <IconButton
            size="small"
            aria-label={t("translationEditor.addLanguage")}
            aria-expanded={showAddLang}
            onClick={() => setShowAddLang((v) => !v)}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {isCustomLang(editLang) && (
          <Tooltip title={t("translationEditor.removeLanguage")}>
            <IconButton
              size="small"
              color="error"
              aria-label={t("translationEditor.removeLanguage")}
              onClick={() => setConfirmRemove(true)}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      <Collapse in={showAddLang}>
        <Box
          display="flex"
          gap={1}
          mb={2}
          alignItems="flex-start"
          flexWrap="wrap"
        >
          <TextField
            size="small"
            label={t("translationEditor.newLanguageCode")}
            value={newLangCode}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setNewLangCode(e.target.value)
            }
            error={!!addLangError}
            sx={{ width: 180 }}
          />
          <TextField
            size="small"
            label={t("translationEditor.newLanguageName")}
            value={newLangName}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setNewLangName(e.target.value)
            }
            sx={{ width: 220 }}
          />
          <Button variant="contained" size="small" onClick={handleAddLanguage}>
            {t("translationEditor.addLanguageButton")}
          </Button>
          {addLangError && (
            <Typography variant="caption" color="error" sx={{ mt: 0.5 }}>
              {addLangError}
            </Typography>
          )}
        </Box>
      </Collapse>

      <Alert severity="info" sx={{ mb: 2 }}>
        {t("translationEditor.info")}
      </Alert>

      <Box display="flex" alignItems="center" gap={2} mb={2} flexWrap="wrap">
        <Box sx={{ flexGrow: 1, minWidth: 200 }}>
          <Box
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            mb={0.5}
          >
            <Typography variant="body2" color="text.secondary">
              {t("translationEditor.progress", {
                translated: translatedKeys,
                total: totalKeys,
              })}
            </Typography>
            <Typography variant="body2" fontWeight={600}>
              {Math.round(progress)}%
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={progress}
            sx={{ height: 8, borderRadius: 4 }}
          />
        </Box>
        {overriddenKeys > 0 && (
          <Chip
            label={t("translationEditor.localEdits", {
              count: overriddenKeys,
            })}
            color="primary"
            size="small"
          />
        )}
      </Box>

      <Box display="flex" gap={1} mb={2} flexWrap="wrap">
        <TextField
          size="small"
          placeholder={t("translationEditor.searchPlaceholder")}
          value={search}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            setSearch(e.target.value)
          }
          sx={{ flexGrow: 1, minWidth: 200 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <Select
            value={filterMode}
            onChange={(_e: { target: { value: string } }) =>
              setFilterMode(_e.target.value as "all" | "missing" | "edited")
            }
          >
            <MenuItem value="all">{t("translationEditor.filterAll")}</MenuItem>
            <MenuItem value="missing">
              {t("translationEditor.filterMissing")}
            </MenuItem>
            <MenuItem value="edited">
              {t("translationEditor.filterEdited")}
            </MenuItem>
          </Select>
        </FormControl>
      </Box>

      <Box display="flex" gap={1} mb={3} flexWrap="wrap">
        <Button
          variant="outlined"
          size="small"
          startIcon={<DownloadIcon />}
          onClick={handleExport}
        >
          {t("translationEditor.exportJson")}
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<UploadFileIcon />}
          onClick={handleImportJson}
        >
          {t("translationEditor.importJson")}
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<ContentCopyIcon />}
          onClick={handleCopyJson}
        >
          {t("translationEditor.copyJson")}
        </Button>
        {overriddenKeys > 0 && (
          <Button
            variant="outlined"
            size="small"
            color="warning"
            startIcon={<RestoreIcon />}
            onClick={handleResetAll}
          >
            {t("translationEditor.resetAll")}
          </Button>
        )}
      </Box>

      {sections.map((section) => (
        <Box key={section} sx={{ mb: 3 }}>
          <Typography
            variant="subtitle1"
            fontWeight={600}
            sx={{ mb: 1, textTransform: "capitalize" }}
          >
            {section}
          </Typography>
          <Divider sx={{ mb: 1.5 }} />
          {filteredEntries
            .filter((e) => e.section === section)
            .map((entry) => (
              <Box
                key={entry.key}
                sx={{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", md: "1fr 1fr auto" },
                  gap: 1,
                  mb: 1.5,
                  alignItems: "start",
                }}
              >
                <Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontFamily: "monospace" }}
                  >
                    {entry.key}
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 0.25 }}>
                    {entry.enValue}
                  </Typography>
                </Box>
                <TextField
                  size="small"
                  fullWidth
                  multiline={entry.enValue.length > 60}
                  minRows={1}
                  maxRows={4}
                  value={entry.currentValue}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleChange(entry.key, e.target.value)
                  }
                  placeholder={entry.enValue}
                  sx={{
                    "& .MuiOutlinedInput-root": entry.isOverridden
                      ? {
                          borderColor: "primary.main",
                          "& fieldset": {
                            borderColor: "primary.main",
                            borderWidth: 2,
                          },
                        }
                      : {},
                  }}
                />
                {entry.isOverridden && (
                  <Tooltip title={t("translationEditor.resetKey")}>
                    <IconButton
                      size="small"
                      aria-label={t("translationEditor.resetKey")}
                      onClick={() => handleResetKey(entry.key)}
                    >
                      <RestoreIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            ))}
        </Box>
      ))}

      {filteredEntries.length === 0 && (
        <Typography color="text.secondary" sx={{ textAlign: "center", py: 4 }}>
          {t("translationEditor.noResults")}
        </Typography>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title={t("translationEditor.removeLanguage")}
        message={t("translationEditor.removeLanguageConfirm", {
          name: customLangs.find((l) => l.code === editLang)?.name ?? editLang,
        })}
        confirmLabel={t("translationEditor.removeLanguage")}
        onConfirm={handleRemoveLanguage}
        onCancel={() => setConfirmRemove(false)}
      />
    </Box>
  );
}
