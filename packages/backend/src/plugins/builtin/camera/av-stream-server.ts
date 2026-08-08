import type { MaybePromise } from "@matter/general";
import { CameraAvStreamManagementServer } from "@matter/main/behaviors";
import { CameraAvStreamManagement } from "@matter/main/clusters";
import type { WebRtcBridge } from "./webrtc-bridge.js";

// ImageControl carries no commands; it is on so we can set an image-orientation
// attribute, which matter.js requires (a "choice b" conformance group) even
// though the bridge does not rotate or flip.
const Base = CameraAvStreamManagementServer.with(
  "Video",
  "Snapshot",
  "ImageControl",
);

// The 6 CameraAvStreamManagement commands. Allocation is just bookkeeping (the
// real media comes from HA over WebRTC); captureSnapshot pulls a JPEG from HA.
// No Audio: the bridge never forwards audio, so we don't advertise the feature.
export class CameraAvStreamServer extends Base {
  declare state: CameraAvStreamServer.State;

  override setStreamPriorities(
    request: CameraAvStreamManagement.SetStreamPrioritiesRequest,
  ): MaybePromise {
    this.state.streamUsagePriorities = request.streamPriorities;
  }

  override videoStreamAllocate(
    request: CameraAvStreamManagement.VideoStreamAllocateRequest,
  ): MaybePromise<CameraAvStreamManagement.VideoStreamAllocateResponse> {
    const videoStreamId = this.state.nextVideoStreamId++;
    this.state.allocatedVideoStreams = [
      ...this.state.allocatedVideoStreams,
      {
        videoStreamId,
        streamUsage: request.streamUsage,
        videoCodec: request.videoCodec,
        minFrameRate: request.minFrameRate,
        maxFrameRate: request.maxFrameRate,
        minResolution: request.minResolution,
        maxResolution: request.maxResolution,
        minBitRate: request.minBitRate,
        maxBitRate: request.maxBitRate,
        keyFrameInterval: request.keyFrameInterval,
        watermarkEnabled: request.watermarkEnabled,
        osdEnabled: request.osdEnabled,
        referenceCount: 1,
      },
    ];
    return { videoStreamId };
  }

  override videoStreamDeallocate(
    request: CameraAvStreamManagement.VideoStreamDeallocateRequest,
  ): MaybePromise {
    this.state.allocatedVideoStreams = this.state.allocatedVideoStreams.filter(
      (s) => s.videoStreamId !== request.videoStreamId,
    );
  }

  override snapshotStreamAllocate(
    request: CameraAvStreamManagement.SnapshotStreamAllocateRequest,
  ): MaybePromise<CameraAvStreamManagement.SnapshotStreamAllocateResponse> {
    const snapshotStreamId = this.state.nextSnapshotStreamId++;
    this.state.allocatedSnapshotStreams = [
      ...this.state.allocatedSnapshotStreams,
      {
        snapshotStreamId,
        imageCodec: request.imageCodec,
        frameRate: request.maxFrameRate,
        minResolution: request.minResolution,
        maxResolution: request.maxResolution,
        quality: request.quality,
        referenceCount: 1,
        encodedPixels: false,
        hardwareEncoder: false,
      },
    ];
    return { snapshotStreamId };
  }

  override snapshotStreamDeallocate(
    request: CameraAvStreamManagement.SnapshotStreamDeallocateRequest,
  ): MaybePromise {
    this.state.allocatedSnapshotStreams =
      this.state.allocatedSnapshotStreams.filter(
        (s) => s.snapshotStreamId !== request.snapshotStreamId,
      );
  }

  override async captureSnapshot(
    request: CameraAvStreamManagement.CaptureSnapshotRequest,
  ): Promise<CameraAvStreamManagement.CaptureSnapshotResponse> {
    const data = await this.state.bridge.snapshot(this.state.entityId);
    return {
      data,
      imageCodec: CameraAvStreamManagement.ImageCodec.Jpeg,
      resolution: request.requestedResolution,
    };
  }
}

export namespace CameraAvStreamServer {
  export class State extends Base.State {
    bridge!: WebRtcBridge;
    entityId!: string;
    nextVideoStreamId = 1;
    nextSnapshotStreamId = 1;
  }
}
