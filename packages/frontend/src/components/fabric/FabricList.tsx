import type { BridgeFabric } from "@home-assistant-matter-hub/common";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { FabricIcon } from "./FabricIcon.tsx";
import { getVendorName } from "./vendor-names.ts";

export interface FabricListProps {
  fabrics: BridgeFabric[];
}

export const FabricList = (props: FabricListProps) => {
  return (
    <>
      {props.fabrics.map((fabric) => (
        <Box
          key={fabric.fabricId}
          sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 0.5 }}
        >
          <FabricIcon fabric={fabric} />
          <Typography variant="body2">
            {fabric.label || getVendorName(fabric.rootVendorId)}
          </Typography>
        </Box>
      ))}
    </>
  );
};
