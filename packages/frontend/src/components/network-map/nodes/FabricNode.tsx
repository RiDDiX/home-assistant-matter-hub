import CastConnectedIcon from "@mui/icons-material/CastConnected";
import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { getVendorName } from "../../../components/fabric/vendor-names.ts";

export interface FabricNodeData {
  label: string;
  vendorId: number;
  [key: string]: unknown;
}

export const FabricNode = ({ data }: NodeProps) => {
  const { label, vendorId } = data as unknown as FabricNodeData;
  const theme = useTheme();
  const vendorName =
    getVendorName(vendorId) !== `Vendor ${vendorId}`
      ? getVendorName(vendorId)
      : label || `Vendor ${vendorId}`;

  return (
    <Box
      sx={{
        background: `linear-gradient(135deg, ${theme.palette.secondary.dark}, ${theme.palette.secondary.main})`,
        borderRadius: 2,
        px: 1.5,
        py: 1,
        minWidth: 140,
        color: theme.palette.secondary.contrastText,
        boxShadow: `0 2px 12px ${theme.palette.mode === "dark" ? "rgba(0,0,0,0.4)" : "rgba(123,31,162,0.3)"}`,
      }}
    >
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0 }}
        id="bottom"
      />

      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <CastConnectedIcon sx={{ fontSize: 16 }} />
        <Typography variant="caption" sx={{ fontWeight: 700 }}>
          {vendorName}
        </Typography>
      </Box>

      {label && label !== vendorName && (
        <Typography
          variant="caption"
          sx={{ display: "block", opacity: 0.8, fontSize: "0.6rem" }}
        >
          {label}
        </Typography>
      )}
    </Box>
  );
};
