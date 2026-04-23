import Autocomplete from "@mui/material/Autocomplete";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";

interface HaEntityOption {
  entity_id: string;
  friendly_name?: string;
  domain: string;
  state: string;
}

interface EntityAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  helperText?: string;
  domain?: string;
  fullWidth?: boolean;
  margin?: "none" | "dense" | "normal";
}

export function EntityAutocomplete({
  value,
  onChange,
  label,
  placeholder,
  helperText,
  domain,
  fullWidth = true,
  margin = "normal",
}: EntityAutocompleteProps) {
  const [options, setOptions] = useState<HaEntityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const initialValueRef = useRef(value);

  const fetchEntities = useCallback(
    async (search: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (domain) params.set("domain", domain);
        if (search) params.set("search", search);

        const response = await fetch(
          `api/home-assistant/entities?${params.toString()}`,
        );
        if (response.ok) {
          const data = await response.json();
          setOptions(data.entities ?? []);
        }
      } catch {
        // silently fail — user can still type manually
      } finally {
        setLoading(false);
      }
    },
    [domain],
  );

  // Load initial options on mount
  useEffect(() => {
    fetchEntities(initialValueRef.current);
  }, [fetchEntities]);

  const handleInputChange = useCallback(
    (_: unknown, newInput: string) => {
      setInputValue(newInput);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        fetchEntities(newInput);
      }, 300);
    },
    [fetchEntities],
  );

  const handleChange = useCallback(
    (_: unknown, newValue: string | HaEntityOption | null) => {
      if (!newValue) {
        onChange("");
      } else if (typeof newValue === "string") {
        onChange(newValue);
      } else {
        onChange(newValue.entity_id);
      }
    },
    [onChange],
  );

  return (
    <Autocomplete
      freeSolo
      options={options}
      getOptionLabel={(option) =>
        typeof option === "string" ? option : option.entity_id
      }
      renderOption={(props, option) => {
        const { key, ...rest } =
          props as React.HTMLAttributes<HTMLLIElement> & {
            key: string;
          };
        return (
          <li key={key} {...rest}>
            <div>
              <Typography variant="body2">{option.entity_id}</Typography>
              {option.friendly_name && (
                <Typography variant="caption" color="text.secondary">
                  {option.friendly_name}
                </Typography>
              )}
            </div>
          </li>
        );
      }}
      isOptionEqualToValue={(option, val) => {
        const optId = typeof option === "string" ? option : option.entity_id;
        const valId = typeof val === "string" ? val : val.entity_id;
        return optId === valId;
      }}
      value={value || null}
      inputValue={inputValue}
      onInputChange={handleInputChange}
      onChange={handleChange}
      loading={loading}
      filterOptions={(x) => x}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          helperText={helperText}
          fullWidth={fullWidth}
          margin={margin}
        />
      )}
    />
  );
}
