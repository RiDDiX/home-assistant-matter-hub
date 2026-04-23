import DevicesIcon from "@mui/icons-material/Devices";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export interface DeviceNodeData {
  label: string;
  deviceType: string;
  entityId: string;
  [key: string]: unknown;
}

export const DeviceNode = ({ data }: NodeProps) => {
  const { label, deviceType } = data as unknown as DeviceNodeData;

  return (
    <Box
      sx={{
        background: (theme) => theme.palette.background.paper,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1.5,
        px: 1.5,
        py: 1,
        minWidth: 150,
        maxWidth: 200,
        boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
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
        <DevicesIcon sx={{ fontSize: 14, color: "text.secondary" }} />
        <Typography
          variant="caption"
          noWrap
          sx={{ fontWeight: 600, maxWidth: 160 }}
        >
          {label}
        </Typography>
      </Box>

      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        sx={{ display: "block", fontSize: "0.6rem", mt: 0.25 }}
      >
        {deviceType}
      </Typography>
    </Box>
  );
};
