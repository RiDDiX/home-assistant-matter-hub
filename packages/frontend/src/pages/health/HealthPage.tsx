import Box from "@mui/material/Box";
import { BackupRestore } from "../../components/backup/BackupRestore.tsx";
import { HealthDashboard } from "../../components/health/HealthDashboard.tsx";
import { SystemInfo } from "../../components/system/SystemInfo.tsx";

export const HealthPage = () => {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <HealthDashboard />
      <Box sx={{ px: 2, pb: 2 }}>
        <SystemInfo />
      </Box>
      <Box sx={{ px: 2, pb: 2 }}>
        <BackupRestore />
      </Box>
    </Box>
  );
};
