import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import { DragIndicator, RocketLaunch, Save } from "@mui/icons-material";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  checkBridgeIconExists,
  getBridgeIconUrl,
} from "../../api/bridge-icons.ts";
import { Breadcrumbs } from "../../components/breadcrumbs/Breadcrumbs.tsx";
import {
  getBridgeIcon,
  getBridgeIconColor,
} from "../../components/bridge/bridgeIconUtils.ts";
import { useNotifications } from "../../components/notifications/use-notifications.ts";
import {
  useBridges,
  useUpdateBridgePriorities,
} from "../../hooks/data/bridges";
import { navigation } from "../../routes.tsx";

interface SortableBridgeCardProps {
  bridge: BridgeDataWithMetadata;
  index: number;
}

const SortableBridgeCard = ({ bridge, index }: SortableBridgeCardProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: bridge.id });

  const [hasCustomIcon, setHasCustomIcon] = useState(false);

  useEffect(() => {
    checkBridgeIconExists(bridge.id).then(setHasCustomIcon);
  }, [bridge.id]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      variant="outlined"
      sx={{
        cursor: "grab",
        "&:active": { cursor: "grabbing" },
        bgcolor: isDragging ? "action.selected" : "background.paper",
        width: "fit-content",
      }}
    >
      <CardContent
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          py: 1,
          "&:last-child": { pb: 1 },
        }}
      >
        <Box
          {...attributes}
          {...listeners}
          sx={{
            display: "flex",
            alignItems: "center",
            color: "text.secondary",
          }}
        >
          <DragIndicator />
        </Box>

        <Chip
          label={index + 1}
          size="small"
          color="primary"
          sx={{ minWidth: 32, fontWeight: "bold" }}
        />

        {hasCustomIcon ? (
          <Box
            component="img"
            src={getBridgeIconUrl(bridge.id)}
            alt={bridge.name}
            sx={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              objectFit: "cover",
              boxShadow: 2,
            }}
          />
        ) : (
          <Avatar
            sx={{
              bgcolor: getBridgeIconColor(bridge),
              width: 40,
              height: 40,
              boxShadow: 2,
            }}
          >
            {(() => {
              const Icon = getBridgeIcon(bridge);
              return <Icon sx={{ fontSize: 24 }} />;
            })()}
          </Avatar>
        )}

        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle1" fontWeight={500}>
            {bridge.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Port: {bridge.port} • Priority: {bridge.priority ?? 100}
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
};

export const StartupPage = () => {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const { content: bridges, isLoading } = useBridges();
  const updatePriorities = useUpdateBridgePriorities();

  const [orderedBridges, setOrderedBridges] = useState<
    BridgeDataWithMetadata[]
  >([]);
  const [hasChanges, setHasChanges] = useState(false);

  // Initialize ordered bridges sorted by priority
  useEffect(() => {
    if (bridges) {
      const sorted = [...bridges].sort((a, b) => {
        const priorityA = a.priority ?? 100;
        const priorityB = b.priority ?? 100;
        return priorityA - priorityB;
      });
      setOrderedBridges(sorted);
      setHasChanges(false);
    }
  }, [bridges]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setOrderedBridges((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
      setHasChanges(true);
    }
  }, []);

  const handleSave = useCallback(async () => {
    // Create priority updates: position * 10 (so 1st = 10, 2nd = 20, etc.)
    const updates = orderedBridges.map((bridge, index) => ({
      id: bridge.id,
      priority: (index + 1) * 10,
    }));

    try {
      await updatePriorities(updates);
      notifications.show({
        message: t("startup.saveSuccess"),
        severity: "success",
      });
      setHasChanges(false);
    } catch (e) {
      notifications.show({
        message: e instanceof Error ? e.message : t("startup.saveFailed"),
        severity: "error",
      });
    }
  }, [orderedBridges, updatePriorities, notifications, t]);

  const bridgeIds = useMemo(
    () => orderedBridges.map((b) => b.id),
    [orderedBridges],
  );

  if (isLoading) {
    return <Typography>{t("common.loading")}...</Typography>;
  }

  return (
    <Stack spacing={3}>
      <Breadcrumbs
        items={[
          { name: t("nav.bridges"), to: navigation.bridges },
          { name: t("startup.title"), to: navigation.startup },
        ]}
      />

      <Box display="flex" alignItems="center" gap={2}>
        <RocketLaunch color="primary" fontSize="large" />
        <Box>
          <Typography variant="h5" fontWeight={600}>
            {t("startup.title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("startup.description")}
          </Typography>
        </Box>
      </Box>

      {hasChanges && (
        <Alert
          severity="info"
          action={
            <Button
              color="inherit"
              size="small"
              startIcon={<Save />}
              onClick={handleSave}
            >
              {t("startup.saveChanges")}
            </Button>
          }
        >
          {t("startup.unsavedChanges")}
        </Alert>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={bridgeIds}
          strategy={verticalListSortingStrategy}
        >
          <Stack spacing={1}>
            {orderedBridges.map((bridge, index) => (
              <SortableBridgeCard
                key={bridge.id}
                bridge={bridge}
                index={index}
              />
            ))}
          </Stack>
        </SortableContext>
      </DndContext>

      {orderedBridges.length === 0 && (
        <Typography color="text.secondary" textAlign="center" py={4}>
          {t("startup.noBridges")}
        </Typography>
      )}

      {hasChanges && orderedBridges.length > 0 && (
        <Box display="flex" justifyContent="flex-end">
          <Button variant="contained" startIcon={<Save />} onClick={handleSave}>
            {t("startup.saveOrder")}
          </Button>
        </Box>
      )}
    </Stack>
  );
};
