import { useCallback, useState } from "react";

export interface DashboardWidgetDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export const AVAILABLE_WIDGETS: readonly DashboardWidgetDef[] = [
  {
    id: "stats",
    label: "Status Overview",
    description:
      "Bridge count, device count, fabric count, and HA connection status.",
  },
  {
    id: "bridges",
    label: "Bridges",
    description: "Bridge cards with bulk actions (start/stop/restart all).",
  },
  {
    id: "quickNav",
    label: "Quick Navigation",
    description:
      "Shortcut cards to other pages (Devices, Network Map, Health, etc.).",
  },
] as const;

const STORAGE_KEY = "hamh-dashboard-widgets";

export interface DashboardWidgetConfig {
  order: string[];
  hidden: string[];
}

const DEFAULT_CONFIG: DashboardWidgetConfig = {
  order: AVAILABLE_WIDGETS.map((w) => w.id),
  hidden: [],
};

function loadConfig(): DashboardWidgetConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as DashboardWidgetConfig;
    // Ensure all known widgets are present in order
    const known = new Set(AVAILABLE_WIDGETS.map((w) => w.id));
    const order = parsed.order.filter((id) => known.has(id));
    for (const w of AVAILABLE_WIDGETS) {
      if (!order.includes(w.id)) order.push(w.id);
    }
    return {
      order,
      hidden: (parsed.hidden || []).filter((id) => known.has(id)),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: DashboardWidgetConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function useDashboardWidgets() {
  const [config, setConfig] = useState<DashboardWidgetConfig>(loadConfig);

  const isVisible = useCallback(
    (id: string) => !config.hidden.includes(id),
    [config.hidden],
  );

  const visibleWidgets = config.order.filter(
    (id) => !config.hidden.includes(id),
  );

  const toggleWidget = useCallback((id: string) => {
    setConfig((prev) => {
      const hidden = prev.hidden.includes(id)
        ? prev.hidden.filter((h) => h !== id)
        : [...prev.hidden, id];
      const next = { ...prev, hidden };
      saveConfig(next);
      return next;
    });
  }, []);

  const moveWidget = useCallback((id: string, direction: "up" | "down") => {
    setConfig((prev) => {
      const order = [...prev.order];
      const idx = order.indexOf(id);
      if (idx < 0) return prev;
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= order.length) return prev;
      [order[idx], order[swapIdx]] = [order[swapIdx], order[idx]];
      const next = { ...prev, order };
      saveConfig(next);
      return next;
    });
  }, []);

  const resetToDefaults = useCallback(() => {
    saveConfig(DEFAULT_CONFIG);
    setConfig(DEFAULT_CONFIG);
  }, []);

  return {
    config,
    visibleWidgets,
    isVisible,
    toggleWidget,
    moveWidget,
    resetToDefaults,
  };
}
