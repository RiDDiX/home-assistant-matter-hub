import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import Box from "@mui/material/Box";
import { useColorScheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export interface FailedNodeData {
  label: string;
  reason: string;
  [key: string]: unknown;
}

export const FailedNode = ({ data }: NodeProps) => {
  const { label, reason } = data as unknown as FailedNodeData;
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
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
          noWrap
          sx={{ fontWeight: 600, maxWidth: 160, color: textColor }}
        >
          {label}
        </Typography>
      </Box>

      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        title={reason}
        sx={{ display: "block", fontSize: "0.6rem", mt: 0.25 }}
      >
        {reason}
      </Typography>
    </Box>
  );
};
