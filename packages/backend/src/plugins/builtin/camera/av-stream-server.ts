import type { MaybePromise } from "@matter/general";
import { CameraAvStreamManagementServer } from "@matter/main/behaviors";
import { CameraAvStreamManagement } from "@matter/main/clusters";
import type { StreamUsage } from "@matter/types";
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
    return { videoStreamId: this.allocateVideo(request) };
  }

  private allocateVideo(
    request: CameraAvStreamManagement.VideoStreamAllocateRequest,
  ): number {
    // allocated streams are stored, the counter is not: never reuse a stored id
    const videoStreamId = Math.max(
      this.state.nextVideoStreamId,
      ...this.state.allocatedVideoStreams.map((s) => s.videoStreamId + 1),
    );
    this.state.nextVideoStreamId = videoStreamId + 1;
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
        // no WMARK/OSD feature, storing even false fails conformance and
        // SmartThings always sends both
        referenceCount: 1,
      },
    ];
    return videoStreamId;
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
    const snapshotStreamId = Math.max(
      this.state.nextSnapshotStreamId,
      ...this.state.allocatedSnapshotStreams.map((s) => s.snapshotStreamId + 1),
    );
    this.state.nextSnapshotStreamId = snapshotStreamId + 1;
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

  // A WebRTC session must name a video stream (Matter 1.5). Reuse one the
  // controller allocated for this usage, else allocate one ourselves.
  videoStreamFor(streamUsage: StreamUsage): number {
    const allocated = this.state.allocatedVideoStreams.find(
      (s) => s.streamUsage === streamUsage,
    );
    if (allocated) return allocated.videoStreamId;
    const { sensorWidth, sensorHeight, maxFps } = this.state.videoSensorParams;
    const resolution = { width: sensorWidth, height: sensorHeight };
    return this.allocateVideo({
      streamUsage,
      videoCodec: CameraAvStreamManagement.VideoCodec.H264,
      minFrameRate: 1,
      maxFrameRate: maxFps,
      minResolution: resolution,
      maxResolution: resolution,
      minBitRate: 10_000,
      maxBitRate: this.state.maxNetworkBandwidth,
      keyFrameInterval: 4000,
    });
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
