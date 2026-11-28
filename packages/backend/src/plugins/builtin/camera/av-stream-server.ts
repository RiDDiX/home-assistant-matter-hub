import { Logger, type MaybePromise } from "@matter/general";
import { CameraAvStreamManagementServer } from "@matter/main/behaviors";
import { CameraAvStreamManagement } from "@matter/main/clusters";
import { StatusCode, StatusResponseError } from "@matter/main/types";
import { StreamUsage } from "@matter/types";
import type { WebRtcBridge } from "./webrtc-bridge.js";

const logger = Logger.get("CameraWebRtc");

// ImageControl carries no commands; it is on so we can set an image-orientation
// attribute, which matter.js requires (a "choice b" conformance group) even
// though the bridge does not rotate or flip. Audio is mandatory on a Camera and
// the bridge relays HA's audio track.
const Base = CameraAvStreamManagementServer.with(
  "Audio",
  "Video",
  "Snapshot",
  "ImageControl",
);

// The 8 CameraAvStreamManagement commands. Allocation is just bookkeeping (the
// real media comes from HA over WebRTC); captureSnapshot pulls a JPEG from HA.
export class CameraAvStreamServer extends Base {
  declare state: CameraAvStreamServer.State;

  override async initialize() {
    await super.initialize();
    // sessions do not survive a restart, nothing uses a stored stream yet
    this.countAudioUse([]);
    if (this.state.microphoneMuted) this.muteMicrophone(true);
    this.reactTo(this.events.microphoneMuted$Changed, this.muteMicrophone, {
      offline: true,
    });
  }

  private muteMicrophone(muted: boolean) {
    this.state.bridge.setMicrophoneMuted(this.state.entityId, muted);
  }

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

  override audioStreamAllocate(
    request: CameraAvStreamManagement.AudioStreamAllocateRequest,
  ): MaybePromise<CameraAvStreamManagement.AudioStreamAllocateResponse> {
    // matter.js refuses undefined enum values, not a valid one the spec bars
    // here or a bit depth off the list. CHIP answers these with
    // CONSTRAINT_ERROR first (TC-AVSM-2.5)
    if (
      ![
        StreamUsage.Recording,
        StreamUsage.Analysis,
        StreamUsage.LiveView,
      ].includes(request.streamUsage) ||
      ![
        CameraAvStreamManagement.AudioCodec.Opus,
        CameraAvStreamManagement.AudioCodec.AacLc,
      ].includes(request.audioCodec) ||
      ![8, 16, 24, 32].includes(request.bitDepth)
    ) {
      logger.info(`audioStreamAllocate refused: ${JSON.stringify(request)}`);
      throw new StatusResponseError(
        "AudioStreamAllocate field out of range",
        StatusCode.ConstraintError,
      );
    }
    if (!this.state.streamUsagePriorities.includes(request.streamUsage)) {
      logger.info(`audioStreamAllocate refused: ${JSON.stringify(request)}`);
      throw new StatusResponseError(
        "StreamUsage is not in StreamUsagePriorities",
        StatusCode.InvalidInState,
      );
    }
    const caps = this.state.microphoneCapabilities;
    if (
      !caps.supportedCodecs.includes(request.audioCodec) ||
      request.channelCount > caps.maxNumberOfChannels ||
      !caps.supportedSampleRates.includes(request.sampleRate) ||
      !caps.supportedBitDepths.includes(request.bitDepth)
    ) {
      logger.info(`audioStreamAllocate refused: ${JSON.stringify(request)}`);
      throw new StatusResponseError(
        "Audio parameters outside MicrophoneCapabilities",
        StatusCode.DynamicConstraintError,
      );
    }
    // the same request again reuses its stream (TC-AVSM-2.14)
    const same = this.state.allocatedAudioStreams.find(
      (s) =>
        s.streamUsage === request.streamUsage &&
        s.audioCodec === request.audioCodec &&
        s.channelCount === request.channelCount &&
        s.sampleRate === request.sampleRate &&
        s.bitRate === request.bitRate &&
        s.bitDepth === request.bitDepth,
    );
    return {
      audioStreamId: same?.audioStreamId ?? this.allocateAudio(request),
    };
  }

  private allocateAudio(
    request: CameraAvStreamManagement.AudioStreamAllocateRequest,
  ): number {
    const audioStreamId = Math.max(
      this.state.nextAudioStreamId,
      ...this.state.allocatedAudioStreams.map((s) => s.audioStreamId + 1),
    );
    this.state.nextAudioStreamId = audioStreamId + 1;
    this.state.allocatedAudioStreams = [
      ...this.state.allocatedAudioStreams,
      {
        audioStreamId,
        streamUsage: request.streamUsage,
        audioCodec: request.audioCodec,
        channelCount: request.channelCount,
        sampleRate: request.sampleRate,
        bitRate: request.bitRate,
        bitDepth: request.bitDepth,
        referenceCount: 0,
      },
    ];
    return audioStreamId;
  }

  override audioStreamDeallocate(
    request: CameraAvStreamManagement.AudioStreamDeallocateRequest,
  ): MaybePromise {
    const stream = this.state.allocatedAudioStreams.find(
      (s) => s.audioStreamId === request.audioStreamId,
    );
    if (!stream) {
      throw new StatusResponseError(
        `No audio stream ${request.audioStreamId}`,
        StatusCode.NotFound,
      );
    }
    if (stream.referenceCount > 0) {
      throw new StatusResponseError(
        `Audio stream ${request.audioStreamId} is in use`,
        StatusCode.InvalidInState,
      );
    }
    this.state.allocatedAudioStreams = this.state.allocatedAudioStreams.filter(
      (s) => s !== stream,
    );
  }

  audioStreamOf(streamUsage: StreamUsage): number | undefined {
    return this.state.allocatedAudioStreams.find(
      (s) => s.streamUsage === streamUsage,
    )?.audioStreamId;
  }

  // A session may only name allocated audio streams
  checkAudioStreams(ids: number[]): void {
    if (new Set(ids).size !== ids.length) {
      throw new StatusResponseError(
        "Duplicate audio stream",
        StatusCode.AlreadyExists,
      );
    }
    for (const id of ids) {
      if (
        !this.state.allocatedAudioStreams.some((s) => s.audioStreamId === id)
      ) {
        throw new StatusResponseError(
          `No audio stream ${id}`,
          StatusCode.DynamicConstraintError,
        );
      }
    }
  }

  // ReferenceCount is the number of WebRTC sessions carrying the stream, a uint8
  countAudioUse(inUse: number[]): void {
    const streams = this.state.allocatedAudioStreams;
    const counted = streams.map((s) => ({
      ...s,
      referenceCount: Math.min(
        255,
        inUse.filter((id) => id === s.audioStreamId).length,
      ),
    }));
    if (
      counted.some((s, i) => s.referenceCount !== streams[i].referenceCount)
    ) {
      this.state.allocatedAudioStreams = counted;
    }
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
    nextAudioStreamId = 0;
    nextSnapshotStreamId = 1;
  }
}
