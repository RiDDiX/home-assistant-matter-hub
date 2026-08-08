import type { EndpointData } from "@home-assistant-matter-hub/common";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import { TreeItem } from "@mui/x-tree-view/TreeItem";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EndpointIcon } from "./EndpointIcon.tsx";
import { EndpointName, getEndpointName } from "./EndpointName.tsx";

export type SortOption = "name" | "endpoint" | "type";

export interface EndpointTreeViewProps {
  endpoint: EndpointData;
  onSelected: (endpoint: EndpointData | undefined) => void;
  sortBy?: SortOption;
}

export const EndpointTreeView = (props: EndpointTreeViewProps) => {
  const [expandedItems, setExpandedItems] = useState<string[]>(() =>
    findEndpointsWithoutNeighbors(props.endpoint),
  );
  const onSelectionChange = (item: string | null) => {
    let selectedItem: EndpointData | undefined;
    if (item) {
      selectedItem = findSelectedEndpoint(item, props.endpoint);
    }
    props.onSelected(selectedItem);
  };

  return (
    <SimpleTreeView
      expandedItems={expandedItems}
      onExpandedItemsChange={(_, items) => setExpandedItems(items)}
      onSelectedItemsChange={(_, item) => onSelectionChange(item)}
    >
      <EndpointTreeItem endpoint={props.endpoint} sortBy={props.sortBy} />
    </SimpleTreeView>
  );
};

interface EndpointTreeItemProps {
  endpoint: EndpointData;
  sortBy?: SortOption;
}

const EndpointTreeItem = (props: EndpointTreeItemProps) => {
  const parts = useMemo(() => {
    const sorted = [...props.endpoint.parts];
    switch (props.sortBy) {
      case "name":
        return sorted.sort((a, b) => {
          const nameA = getEndpointName(a.state) ?? a.id.local;
          const nameB = getEndpointName(b.state) ?? b.id.local;
          return nameA.localeCompare(nameB);
        });
      case "type":
        return sorted.sort((a, b) => {
          const typeA = a.type?.name ?? "";
          const typeB = b.type?.name ?? "";
          return typeA.localeCompare(typeB);
        });
      default:
        return sorted.sort((a, b) => a.endpoint - b.endpoint);
    }
  }, [props.endpoint.parts, props.sortBy]);

  return (
    <TreeItem
      itemId={props.endpoint.id.global}
      label={<EndpointTreeItemLabel endpoint={props.endpoint} />}
    >
      {parts.map((part) => (
        <EndpointTreeItem
          key={part.id.global}
          endpoint={part}
          sortBy={props.sortBy}
        />
      ))}
    </TreeItem>
  );
};

const EndpointTreeItemLabel = (props: EndpointTreeItemProps) => {
  const { t } = useTranslation();
  const isUnavailable = useMemo(() => {
    const state = props.endpoint.state as {
      homeAssistantEntity?: {
        entity?: { state?: { state?: string } };
      };
    };
    const haState = state.homeAssistantEntity?.entity?.state?.state;
    return haState === "unavailable" || haState === "unknown";
  }, [props.endpoint.state]);

  return (
    <Box display="flex" alignItems="center">
      <EndpointIcon endpoint={props.endpoint} />
      <Box
        marginLeft={1}
        component="span"
        whiteSpace="nowrap"
        textOverflow="ellipsis"
        overflow="hidden"
        sx={isUnavailable ? { opacity: 0.6 } : undefined}
      >
        <EndpointName endpoint={props.endpoint} />
      </Box>
      {isUnavailable && (
        <Tooltip title={t("endpoints.entityUnavailable")}>
          <WarningAmberIcon
            color="warning"
            sx={{ fontSize: 16, ml: 0.5, flexShrink: 0 }}
          />
        </Tooltip>
      )}
    </Box>
  );
};

function findEndpointsWithoutNeighbors(endpoint: EndpointData) {
  const result: string[] = [endpoint.id.global];
  const queue = [endpoint];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.parts.length === 1) {
      result.push(item.parts[0].id.global);
    }
    queue.push(...item.parts);
  }
  return result;
}

function findSelectedEndpoint(globalId: string, root: EndpointData) {
  const queue = [root];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.id.global === globalId) {
      return item;
    }
    queue.push(...item.parts);
  }
  return undefined;
}
