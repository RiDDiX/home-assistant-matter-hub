import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { FieldProps } from "@rjsf/utils";
import type { JSONSchema7 } from "json-schema";
import { useCallback } from "react";
import { EntityAutocomplete } from "../../entity-mapping/EntityAutocomplete.tsx";

// matcher types whose value is an entity id, so suggestions help
const ENTITY_ID_TYPES = new Set(["", "pattern", "regex"]);

interface MatcherData {
  type?: string;
  value?: string;
}

interface TypeOption {
  const?: string;
  title?: string;
  description?: string;
}

export function EntityFilterRuleField(props: FieldProps) {
  const { schema, formData, onChange, disabled, readonly, fieldPathId } = props;
  const data = (formData ?? {}) as MatcherData;
  const type = data.type ?? "";
  const value = data.value ?? "";
  const locked = disabled || readonly;

  const properties = (schema.properties ?? {}) as Record<string, JSONSchema7>;
  const typeOptions = ((properties.type?.oneOf ?? []) as TypeOption[]).filter(
    (o) => typeof o.const === "string",
  );
  const valueTitle = properties.value?.title ?? "Value";
  const selected = typeOptions.find((o) => o.const === type);

  const setType = useCallback(
    (next: string) => onChange({ ...data, type: next }, fieldPathId.path),
    [data, onChange, fieldPathId],
  );
  const setValue = useCallback(
    (next: string) => onChange({ ...data, value: next }, fieldPathId.path),
    [data, onChange, fieldPathId],
  );

  const useAutocomplete = ENTITY_ID_TYPES.has(type) && !locked;

  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      <FormControl fullWidth size="small" disabled={locked}>
        <InputLabel id={`${fieldPathId.path}-type`}>Type</InputLabel>
        <Select
          labelId={`${fieldPathId.path}-type`}
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {typeOptions.map((o) => (
            <MenuItem key={o.const} value={o.const}>
              {o.title ?? o.const}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {selected?.description && (
        <Typography variant="caption" color="text.secondary">
          {selected.description}
        </Typography>
      )}

      {useAutocomplete ? (
        <EntityAutocomplete
          value={value}
          onChange={setValue}
          label={valueTitle}
          placeholder="sensor.living_room_*"
          helperText="Search or type an entity ID. Wildcards and regex still work."
          margin="none"
        />
      ) : (
        <TextField
          fullWidth
          size="small"
          label={valueTitle}
          value={value}
          disabled={locked}
          onChange={(e) => setValue(e.target.value)}
          helperText={properties.value?.description}
        />
      )}
    </Stack>
  );
}
