import type {
  BridgeDataWithMetadata,
  CreateBridgeRequest,
  UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import { useCallback, useMemo } from "react";
import {
  type BridgePriorityUpdate,
  cloneBridge as cloneBridgeApi,
  forceSyncBridge as forceSyncBridgeApi,
  updateBridgePriorities as updateBridgePrioritiesApi,
} from "../../api/bridges.ts";
import {
  createBridge,
  deleteBridge,
  loadBridges,
  resetBridge,
  updateBridge,
} from "../../state/bridges/bridge-actions.ts";
import {
  selectBridge,
  selectBridges,
  selectUsedPorts,
} from "../../state/bridges/bridge-selectors.ts";
import { useAppDispatch, useAppSelector } from "../../state/hooks.ts";
import type { AsyncError } from "../../state/utils/async.ts";

export function useBridges() {
  return useAppSelector(selectBridges);
}

export function useUsedPorts() {
  return useAppSelector(selectUsedPorts);
}

export function useBridge(bridgeId: string) {
  const selector = useMemo(() => selectBridge(bridgeId), [bridgeId]);
  return useAppSelector(selector);
}

export function useCreateBridge(): (
  req: CreateBridgeRequest,
) => Promise<BridgeDataWithMetadata> {
  const dispatch = useAppDispatch();
  return useCallback(
    async (req: CreateBridgeRequest) => {
      const res = await dispatch(createBridge(req));
      if (res.meta.requestStatus === "rejected") {
        throw (res as { error: AsyncError }).error;
      }
      return res.payload as BridgeDataWithMetadata;
    },
    [dispatch],
  );
}

export function useUpdateBridge(): (
  req: UpdateBridgeRequest,
) => Promise<BridgeDataWithMetadata> {
  const dispatch = useAppDispatch();
  return useCallback(
    async (req: UpdateBridgeRequest) => {
      const res = await dispatch(updateBridge(req));
      if (res.meta.requestStatus === "rejected") {
        throw (res as { error: AsyncError }).error;
      }
      return res.payload as BridgeDataWithMetadata;
    },
    [dispatch],
  );
}

export function useResetBridge(): (
  bridgeId: string,
) => Promise<BridgeDataWithMetadata> {
  const dispatch = useAppDispatch();
  return useCallback(
    async (bridgeId: string) => {
      const res = await dispatch(resetBridge(bridgeId));
      if (res.meta.requestStatus === "rejected") {
        throw (res as { error: AsyncError }).error;
      }
      return res.payload as BridgeDataWithMetadata;
    },
    [dispatch],
  );
}

export function useDeleteBridge(): (bridgeId: string) => Promise<void> {
  const dispatch = useAppDispatch();
  return useCallback(
    async (bridgeId: string) => {
      const res = await dispatch(deleteBridge(bridgeId));
      if (res.meta.requestStatus === "rejected") {
        throw (res as { error: AsyncError }).error;
      }
    },
    [dispatch],
  );
}

export function useUpdateBridgePriorities(): (
  updates: BridgePriorityUpdate[],
) => Promise<void> {
  const dispatch = useAppDispatch();
  return useCallback(
    async (updates: BridgePriorityUpdate[]) => {
      await updateBridgePrioritiesApi(updates);
      // Reload bridges to get updated priorities
      await dispatch(loadBridges());
    },
    [dispatch],
  );
}

export function useForceSyncBridge(): (
  bridgeId: string,
) => Promise<{ syncedCount: number; bridge: BridgeDataWithMetadata }> {
  const dispatch = useAppDispatch();
  return useCallback(
    async (bridgeId: string) => {
      const result = await forceSyncBridgeApi(bridgeId);
      // Reload bridges to reflect any state changes
      await dispatch(loadBridges());
      return result;
    },
    [dispatch],
  );
}

export function useCloneBridge(): (
  bridgeId: string,
) => Promise<BridgeDataWithMetadata> {
  const dispatch = useAppDispatch();
  return useCallback(
    async (bridgeId: string) => {
      const clone = await cloneBridgeApi(bridgeId);
      await dispatch(loadBridges());
      return clone;
    },
    [dispatch],
  );
}
