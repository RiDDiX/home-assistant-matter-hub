import HubIcon from "@mui/icons-material/Hub";
import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export interface HubNodeData {
  label: string;
  bridgeCount: number;
  deviceCount: number;
  [key: string]: unknown;
}

export const HubNode = ({ data }: NodeProps) => {
  const { label, bridgeCount, deviceCount } = data as unknown as HubNodeData;
  const theme = useTheme();
  const primary = theme.palette.primary.main;
  const primaryDark = theme.palette.primary.dark;
  return (
    <Box
      sx={{
        background: `linear-gradient(135deg, ${primary}, ${primaryDark})`,
        borderRadius: "50%",
        width: 120,
        height: 120,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: theme.palette.primary.contrastText,
        boxShadow: `0 4px 20px ${theme.palette.mode === "dark" ? "rgba(0,0,0,0.5)" : "rgba(25,118,210,0.4)"}`,
        border: "3px solid rgba(255,255,255,0.3)",
      }}
    >
      <HubIcon sx={{ fontSize: 32, mb: 0.5 }} />
      <Typography variant="caption" sx={{ fontWeight: 700, lineHeight: 1.1 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ opacity: 0.8, fontSize: "0.65rem" }}>
        {bridgeCount} bridges · {deviceCount} devices
      </Typography>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle
        type="source"
        position={Position.Left}
        style={{ opacity: 0 }}
        id="left"
      />
      <Handle
        type="source"
        position={Position.Top}
        style={{ opacity: 0 }}
        id="top"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0 }}
        id="bottom"
      />
    </Box>
  );
};
