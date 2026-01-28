import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import Grid from "@mui/material/Grid";
import { useMemo } from "react";
import { DeviceCard } from "../devices/DeviceCard.tsx";

export interface BridgeListProps {
  bridges: BridgeDataWithMetadata[];
}

export const BridgeList = ({ bridges }: BridgeListProps) => {
  const sortedBridges = useMemo(
    () =>
      [...bridges].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    [bridges],
  );

  return (
    <Grid container spacing={2}>
      {sortedBridges.map((bridge) => (
        <Grid key={bridge.id} size={{ xs: 12, sm: 6, lg: 4 }}>
          <DeviceCard bridge={bridge} />
        </Grid>
      ))}
    </Grid>
  );
};
