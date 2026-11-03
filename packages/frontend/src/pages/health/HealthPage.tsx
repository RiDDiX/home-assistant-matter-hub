import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HealthDashboard } from "../../components/health/HealthDashboard.tsx";
import { NetworkDiagnosticCard } from "../../components/health/NetworkDiagnosticCard.tsx";
import { TranslationEditor } from "../../components/i18n/TranslationEditor.tsx";
import { SystemInfo } from "../../components/system/SystemInfo.tsx";
import { LiveEventLog } from "../diagnostics/DiagnosticsPage.tsx";

export const HealthPage = () => {
  const [sortField, setSortField] = useState<"name" | "created">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const { t } = useTranslation();

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <HealthDashboard
        sortField={sortField}
        sortDirection={sortDirection}
        onSortFieldChange={setSortField}
        onSortDirectionChange={setSortDirection}
      />
      <LiveEventLog sortField={sortField} sortDirection={sortDirection} />
      <NetworkDiagnosticCard />
      <SystemInfo />
      {/* thousands of rows, mount only when opened */}
      <Accordion
        slotProps={{
          heading: { component: "h2" },
          transition: { unmountOnExit: true },
        }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="h6" component="span">
            {t("translationEditor.title")}
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <TranslationEditor />
        </AccordionDetails>
      </Accordion>
    </Box>
  );
};
