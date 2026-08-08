import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { MediaPlaybackServer as Base } from "@matter/main/behaviors";
import { MediaPlayback } from "@matter/main/clusters";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

export class MediaPlayerMediaPlaybackServer extends Base {
  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    const state = entity.state.state;
    let currentState: MediaPlayback.PlaybackState;

    switch (state) {
      case "playing":
        currentState = MediaPlayback.PlaybackState.Playing;
        break;
      case "paused":
        currentState = MediaPlayback.PlaybackState.Paused;
        break;
      case "idle":
      case "standby":
        currentState = MediaPlayback.PlaybackState.NotPlaying;
        break;
      case "buffering":
        currentState = MediaPlayback.PlaybackState.Buffering;
        break;
      default:
        currentState = MediaPlayback.PlaybackState.NotPlaying;
    }

    applyPatchState(this.state, { currentState });
  }

  override async play(): Promise<MediaPlayback.PlaybackResponse> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (!homeAssistant.isAvailable) {
      return { status: MediaPlayback.Status.InvalidStateForCommand };
    }
    await homeAssistant.callAction({ action: "media_player.media_play" });
    return { status: MediaPlayback.Status.Success };
  }

  override async pause(): Promise<MediaPlayback.PlaybackResponse> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (!homeAssistant.isAvailable) {
      return { status: MediaPlayback.Status.InvalidStateForCommand };
    }
    await homeAssistant.callAction({ action: "media_player.media_pause" });
    return { status: MediaPlayback.Status.Success };
  }

  override async stop(): Promise<MediaPlayback.PlaybackResponse> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (!homeAssistant.isAvailable) {
      return { status: MediaPlayback.Status.InvalidStateForCommand };
    }
    await homeAssistant.callAction({ action: "media_player.media_stop" });
    return { status: MediaPlayback.Status.Success };
  }

  override async startOver(): Promise<MediaPlayback.PlaybackResponse> {
    return { status: MediaPlayback.Status.NotAllowed };
  }

  override async previous(): Promise<MediaPlayback.PlaybackResponse> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (!homeAssistant.isAvailable) {
      return { status: MediaPlayback.Status.InvalidStateForCommand };
    }
    await homeAssistant.callAction({
      action: "media_player.media_previous_track",
    });
    return { status: MediaPlayback.Status.Success };
  }

  override async next(): Promise<MediaPlayback.PlaybackResponse> {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (!homeAssistant.isAvailable) {
      return { status: MediaPlayback.Status.InvalidStateForCommand };
    }
    await homeAssistant.callAction({ action: "media_player.media_next_track" });
    return { status: MediaPlayback.Status.Success };
  }
}
