import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import { createReducer } from "@reduxjs/toolkit";
import {
  createBridge,
  deleteBridge,
  loadBridges,
  resetBridge,
  setBridgesFromWebSocket,
  updateBridge,
  updateBridgeFromWebSocket,
} from "./bridge-actions.ts";
import type { BridgeState } from "./bridge-state.ts";

const initialState: BridgeState = {
  items: { isInitialized: false, isLoading: false },
};

export const bridgesReducer = createReducer(initialState, (builder) => {
  builder
    .addCase(loadBridges.pending, (state) => {
      state.items.isLoading = true;
    })
    .addCase(loadBridges.rejected, (state, action) => {
      state.items.isInitialized = true;
      state.items.isLoading = false;
      state.items.error = action.error;
    })
    .addCase(loadBridges.fulfilled, (state, action) => {
      state.items.isInitialized = true;
      state.items.isLoading = false;
      state.items.content = action.payload;
      state.items.error = undefined;
    })
    .addCase(createBridge.fulfilled, (state, action) => {
      upsert(state, action.payload);
    })
    .addCase(updateBridge.fulfilled, (state, action) => {
      const idx =
        state.items.content?.findIndex((b) => b.id === action.payload.id) ?? -1;
      if (idx !== -1) {
        state.items.content![idx] = action.payload;
      }
    })
    .addCase(resetBridge.fulfilled, (state, action) => {
      const idx =
        state.items.content?.findIndex((b) => b.id === action.payload.id) ?? -1;
      if (idx !== -1) {
        state.items.content![idx] = action.payload;
      }
    })
    .addCase(deleteBridge.fulfilled, (state, action) => {
      if (state.items.content) {
        const idx = state.items.content.findIndex(
          (b) => b.id === action.meta.arg,
        );
        if (idx !== -1) {
          state.items.content.splice(idx, 1);
        }
      }
    })
    .addCase(setBridgesFromWebSocket, (state, action) => {
      state.items.isInitialized = true;
      state.items.isLoading = false;
      state.items.content = action.payload;
      state.items.error = undefined;
    })
    .addCase(updateBridgeFromWebSocket, (state, action) => {
      upsert(state, action.payload);
    });
});

// The WebSocket update for a new bridge can land before the create response.
function upsert(state: BridgeState, bridge: BridgeDataWithMetadata) {
  const content = state.items.content;
  if (!content) {
    return;
  }
  const idx = content.findIndex((b) => b.id === bridge.id);
  if (idx !== -1) {
    content[idx] = bridge;
  } else {
    content.push(bridge);
  }
}
