import {
  type ControllerSupport,
  type MatterDeviceType,
  matterDeviceTypeControllerSupport,
} from "@home-assistant-matter-hub/common";
import Box from "@mui/material/Box";

const controllers: {
  key: "apple" | "google" | "alexa" | "aqara";
  label: string;
  short: string;
}[] = [
  { key: "apple", label: "Apple Home", short: "A" },
  { key: "google", label: "Google Home", short: "G" },
  { key: "alexa", label: "Alexa", short: "X" },
  { key: "aqara", label: "Aqara Home", short: "Q" },
];

const tint: Record<ControllerSupport, string> = {
  yes: "#2e7d32",
  partial: "#ed6c02",
  no: "#9e9e9e",
  unknown: "#9e9e9e",
};

const wordFor: Record<ControllerSupport, string> = {
  yes: "works",
  partial: "partly works",
  no: "not supported",
  unknown: "unverified",
};

// One dot per controller: green works, amber partly, grey not/unverified.
export function ControllerSupportChips({ type }: { type: MatterDeviceType }) {
  const support = matterDeviceTypeControllerSupport[type];
  if (!support) return null;
  return (
    <Box sx={{ display: "inline-flex", gap: 0.5, ml: 1 }}>
      {controllers.map((c) => {
        const value = support[c.key];
        return (
          <Box
            key={c.key}
            component="span"
            title={`${c.label}: ${wordFor[value]}`}
            sx={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 600,
              color: "#fff",
              bgcolor: tint[value],
              opacity: value === "yes" || value === "partial" ? 1 : 0.45,
            }}
          >
            {c.short}
          </Box>
        );
      })}
    </Box>
  );
}

// Short, plain warning when the picked type is not supported somewhere, plus
// the type's own note. Returns undefined when there is nothing to flag.
export function controllerSupportWarning(
  type: MatterDeviceType,
): string | undefined {
  const support = matterDeviceTypeControllerSupport[type];
  if (!support) return undefined;
  const missing = controllers
    .filter((c) => support[c.key] === "no")
    .map((c) => c.label);
  const parts: string[] = [];
  if (missing.length === 1) {
    parts.push(
      `${missing[0]} does not support this type, so it may not show up there.`,
    );
  } else if (missing.length > 1) {
    parts.push(
      `${missing.join(" and ")} do not support this type, so it may not show up there.`,
    );
  }
  if (support.note) parts.push(support.note);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
