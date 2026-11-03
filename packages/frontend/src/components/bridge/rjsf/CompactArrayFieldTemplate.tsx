import AddIcon from "@mui/icons-material/Add";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ArrowRightIcon from "@mui/icons-material/ArrowRight";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ArrayFieldTemplateProps } from "@rjsf/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

function usePrevLength(length: number): number {
  const ref = useRef(length);
  const prev = ref.current;
  ref.current = length;
  return prev;
}

interface MatcherData {
  type?: string;
  value?: string;
}

export function CompactArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { t } = useTranslation();
  const { items, canAdd, onAddClick, title, formData } = props;
  const dataArray = (formData ?? []) as MatcherData[];

  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(
    () => new Set(),
  );
  const [search, setSearch] = useState("");

  // Auto-expand newly added (empty) items
  const prevLength = usePrevLength(dataArray.length);
  useEffect(() => {
    if (dataArray.length > prevLength) {
      const lastIdx = dataArray.length - 1;
      const last = dataArray[lastIdx];
      if (!last?.type && !last?.value) {
        setExpandedIndices((prev) => new Set([...prev, lastIdx]));
      }
    }
  }, [dataArray, prevLength]);

  const toggleExpanded = useCallback((index: number) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const filteredIndices = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    const indices: number[] = [];
    for (let i = 0; i < dataArray.length; i++) {
      const item = dataArray[i];
      const type = item?.type ?? "";
      const value = item?.value ?? "";
      if (type.toLowerCase().includes(q) || value.toLowerCase().includes(q)) {
        indices.push(i);
      }
    }
    return new Set(indices);
  }, [search, dataArray]);

  const visibleIndices = useMemo(() => {
    const all = Array.from({ length: items.length }, (_, i) => i);
    if (!filteredIndices) return all;
    return all.filter((i) => filteredIndices.has(i));
  }, [items.length, filteredIndices]);

  return (
    <Box>
      <Box
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        mb={1}
      >
        <Typography variant="subtitle2" fontWeight={600}>
          {title}
        </Typography>
        <Box display="flex" alignItems="center" gap={1}>
          <Chip
            label={items.length}
            size="small"
            color="default"
            sx={{ height: 22, fontSize: "0.75rem" }}
          />
          {canAdd && (
            <Button size="small" startIcon={<AddIcon />} onClick={onAddClick}>
              {t("common.add")}
            </Button>
          )}
        </Box>
      </Box>

      {items.length > 3 && (
        <TextField
          size="small"
          fullWidth
          placeholder={t("bridgeWizard.searchRules")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="action" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ mb: 1 }}
        />
      )}

      {filteredIndices && visibleIndices.length === 0 && (
        <Typography
          variant="body2"
          color="text.secondary"
          textAlign="center"
          py={2}
        >
          {t("bridge.noMatchingRules")}
        </Typography>
      )}

      <Stack spacing={0.5}>
        {visibleIndices.map((idx) => {
          const data = dataArray[idx];
          const type = data?.type ?? "";
          const value = data?.value ?? "";
          const isExpanded = expandedIndices.has(idx);
          const hasContent = type || value;

          return (
            <Box
              key={idx}
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                overflow: "hidden",
              }}
            >
              <ButtonBase
                component="div"
                aria-expanded={isExpanded}
                onClick={() => toggleExpanded(idx)}
                sx={{
                  width: "100%",
                  justifyContent: "flex-start",
                  textAlign: "left",
                  px: 1.5,
                  py: 0.75,
                  "&:hover": { bgcolor: "action.hover" },
                  bgcolor: isExpanded ? "action.selected" : "transparent",
                }}
              >
                {isExpanded ? (
                  <ArrowDropDownIcon fontSize="small" color="action" />
                ) : (
                  <ArrowRightIcon fontSize="small" color="action" />
                )}
                {hasContent ? (
                  <Box
                    display="flex"
                    alignItems="center"
                    gap={1}
                    ml={0.5}
                    flex={1}
                    minWidth={0}
                  >
                    <Chip
                      label={type}
                      size="small"
                      variant="outlined"
                      sx={{
                        height: 22,
                        fontSize: "0.75rem",
                        flexShrink: 0,
                      }}
                    />
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{ flex: 1, minWidth: 0 }}
                    >
                      {value}
                    </Typography>
                  </Box>
                ) : (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    ml={0.5}
                    fontStyle="italic"
                  >
                    {t("bridge.newRule")}
                  </Typography>
                )}
              </ButtonBase>
              <Collapse in={isExpanded}>
                <Box sx={{ px: 2, pb: 1.5, pt: 0.5 }}>{items[idx]}</Box>
              </Collapse>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
