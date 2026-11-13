import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export interface FailedNodeData {
  label: string;
  reason: string;
  [key: string]: unknown;
}

export const FailedNode = ({ data }: NodeProps) => {
  const { label, reason } = data as unknown as FailedNodeData;
  const isDark = useTheme().palette.mode === "dark";
  const textColor = isDark ? "#ef5350" : "#d32f2f";

  return (
    <Box
      sx={{
        background: isDark ? "#3a1515" : "#ffebee",
        border: "1px dashed #f44336",
        borderRadius: 1.5,
        px: 1.5,
        py: 1,
        minWidth: 150,
        maxWidth: 200,
        opacity: 0.85,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle
        type="target"
        position={Position.Top}
        style={{ opacity: 0 }}
        id="top"
      />

      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <ErrorOutlineIcon sx={{ fontSize: 14, color: textColor }} />
        <Typography
          variant="caption"
          fontWeight={600}
          noWrap
          sx={{ maxWidth: 160, color: textColor }}
        >
          {label}
        </Typography>
      </Box>

      <Typography
        variant="caption"
        color="text.secondary"
        display="block"
        sx={{ fontSize: "0.6rem", mt: 0.25 }}
        noWrap
        title={reason}
      >
        {reason}
      </Typography>
    </Box>
  );
};
