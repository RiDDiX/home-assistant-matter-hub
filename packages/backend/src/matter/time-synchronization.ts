import { Logger } from "@matter/general";
import { TimeSynchronizationServer } from "@matter/main/behaviors";
import { TimeSynchronization } from "@matter/main/clusters";
import { StatusResponse } from "@matter/main/types";

const logger = Logger.get("TimeSynchronizationServer");

// matter.js validates epoch-us in Unix microseconds with a minimum of
// 2000-01-01T00:00:00.000Z (946_684_800_000_000 us = Matter epoch 0).
const MATTER_EPOCH_US_MIN = 946_684_800_000_000;
const MAX_SAFE_EPOCH_US_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function currentMatterEpochUs(nowMs = Date.now()): number {
  return Math.max(MATTER_EPOCH_US_MIN, Math.trunc(nowMs * 1000));
}

function normalizeEpochUs(value: number | bigint): number | bigint {
  if (typeof value === "bigint") {
    if (value > MAX_SAFE_EPOCH_US_BIGINT) {
      return value;
    }
    const n = Number(value);
    return n < MATTER_EPOCH_US_MIN ? n + MATTER_EPOCH_US_MIN : n;
  }
  return value < MATTER_EPOCH_US_MIN ? value + MATTER_EPOCH_US_MIN : value;
}

function compareEpochUs(a: number | bigint, b: number | bigint): number {
  const na = normalizeEpochUs(a);
  const nb = normalizeEpochUs(b);
  if (typeof na === "bigint" || typeof nb === "bigint") {
    const ba = typeof na === "bigint" ? na : BigInt(Math.trunc(na));
    const bb = typeof nb === "bigint" ? nb : BigInt(Math.trunc(nb));
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  }
  return na < nb ? -1 : na > nb ? 1 : 0;
}

function defaultTimeZoneOffsetSeconds(): number {
  const raw = -new Date().getTimezoneOffset() * 60;
  const offset = raw === 0 ? 0 : raw;
  return Math.max(-43200, Math.min(50400, offset));
}

function computeLocalTime(
  utcTime: number | bigint | null | undefined,
  timeZone: TimeSynchronization.TimeZone[],
  dstOffset: TimeSynchronization.DstOffset[],
): number | bigint | null {
  if (utcTime == null || dstOffset.length === 0) {
    return null;
  }
  const activeTz =
    timeZone
      .filter((entry) => compareEpochUs(entry.validAt, utcTime) <= 0)
      .sort((a, b) => compareEpochUs(b.validAt, a.validAt))[0] ?? timeZone[0];
  const tzOffsetSec = activeTz?.offset ?? 0;
  const activeDst = dstOffset.find(
    (entry) =>
      compareEpochUs(entry.validStarting, utcTime) <= 0 &&
      (entry.validUntil == null ||
        compareEpochUs(entry.validUntil, utcTime) > 0),
  );
  const dstOffsetSec = activeDst?.offset ?? 0;
  if (typeof utcTime === "bigint") {
    const local = utcTime + BigInt(tzOffsetSec + dstOffsetSec) * 1_000_000n;
    return local < BigInt(MATTER_EPOCH_US_MIN) ? null : local;
  }
  const local = utcTime + (tzOffsetSec + dstOffsetSec) * 1_000_000;
  return local < MATTER_EPOCH_US_MIN ? null : local;
}

const Base = TimeSynchronizationServer.with(
  TimeSynchronization.Feature.TimeZone,
);

export class RootTimeSynchronizationServer extends Base {
  declare state: RootTimeSynchronizationServer.State;

  override initialize() {
    if (this.state.utcTime == null) {
      const utcTime = currentMatterEpochUs();
      this.state.utcTime = utcTime;
      this.state.granularity =
        TimeSynchronization.Granularity.SecondsGranularity;
      this.state.timeSource = TimeSynchronization.TimeSource.NonMatterNtp;
      this.state.localTime = computeLocalTime(
        utcTime,
        this.state.timeZone,
        this.state.dstOffset,
      );
    }
    return super.initialize();
  }

  override setUtcTime({
    utcTime,
    granularity,
    timeSource,
  }: TimeSynchronization.SetUtcTimeRequest) {
    if (granularity === TimeSynchronization.Granularity.NoTimeGranularity) {
      throw new StatusResponse.ConstraintErrorError(
        "Granularity must not be NoTimeGranularity",
      );
    }
    const normalizedUtc = normalizeEpochUs(utcTime);
    const resolvedTimeSource =
      timeSource == null || timeSource === TimeSynchronization.TimeSource.None
        ? TimeSynchronization.TimeSource.Admin
        : timeSource;
    logger.debug(
      `SetUTCTime utcTime=${String(normalizedUtc)} granularity=${granularity} timeSource=${String(resolvedTimeSource)}`,
    );
    this.state.utcTime = normalizedUtc;
    this.state.granularity = granularity;
    this.state.timeSource = resolvedTimeSource;
    this.state.localTime = computeLocalTime(
      normalizedUtc,
      this.state.timeZone,
      this.state.dstOffset,
    );
  }

  override setTimeZone({
    timeZone,
  }: TimeSynchronization.SetTimeZoneRequest): TimeSynchronization.SetTimeZoneResponse {
    logger.debug(`SetTimeZone entries=${JSON.stringify(timeZone)}`);
    if (timeZone.length > this.state.timeZoneListMaxSize) {
      throw new StatusResponse.ResourceExhaustedError(
        "TimeZone exceeds TimeZoneListMaxSize",
      );
    }
    if (timeZone.length === 0) {
      throw new StatusResponse.ConstraintErrorError(
        "TimeZone requires at least one entry",
      );
    }
    this.state.timeZone = timeZone.map((entry) => ({
      ...entry,
      validAt: normalizeEpochUs(entry.validAt),
    }));
    this.state.dstOffset = [];
    this.state.localTime = null;
    return { dstOffsetRequired: true };
  }

  override setDstOffset({
    dstOffset,
  }: TimeSynchronization.SetDstOffsetRequest) {
    logger.debug(`SetDSTOffset entries=${JSON.stringify(dstOffset)}`);
    if (dstOffset.length > this.state.dstOffsetListMaxSize) {
      throw new StatusResponse.ResourceExhaustedError(
        "DSTOffset exceeds DSTOffsetListMaxSize",
      );
    }
    for (const entry of dstOffset) {
      if (
        entry.validUntil != null &&
        compareEpochUs(entry.validUntil, entry.validStarting) <= 0
      ) {
        throw new StatusResponse.ConstraintErrorError(
          "DSTOffset validUntil must be greater than validStarting",
        );
      }
    }
    this.state.dstOffset = dstOffset.map((entry) => ({
      ...entry,
      validStarting: normalizeEpochUs(entry.validStarting),
      validUntil:
        entry.validUntil == null ? null : normalizeEpochUs(entry.validUntil),
    }));
    this.state.localTime = computeLocalTime(
      this.state.utcTime,
      this.state.timeZone,
      this.state.dstOffset,
    );
  }
}

export namespace RootTimeSynchronizationServer {
  export class State extends Base.State {
    override utcTime: number | bigint | null = null;
    override granularity = TimeSynchronization.Granularity.SecondsGranularity;
    override timeSource = TimeSynchronization.TimeSource.NonMatterNtp;
    override timeZone: TimeSynchronization.TimeZone[] = [
      {
        offset: defaultTimeZoneOffsetSeconds(),
        validAt: MATTER_EPOCH_US_MIN,
      },
    ];
    override dstOffset: TimeSynchronization.DstOffset[] = [
      {
        offset: 0,
        validStarting: MATTER_EPOCH_US_MIN,
        validUntil: null,
      },
    ];
    override localTime: number | bigint | null = null;
    override timeZoneDatabase = TimeSynchronization.TimeZoneDatabase.None;
    override timeZoneListMaxSize = 2;
    override dstOffsetListMaxSize = 2;
  }
}
