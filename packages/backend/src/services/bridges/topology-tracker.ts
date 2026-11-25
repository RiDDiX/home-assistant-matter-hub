import { createHash } from "node:crypto";
import type { Logger } from "@matter/general";
import { type Endpoint, ServerNodeStore } from "@matter/main";
import {
  BasicInformationServer,
  DescriptorServer,
} from "@matter/main/behaviors";
import type { ServerNode } from "@matter/main/node";

// Wait for the endpoint set to settle before comparing it. Covers the first
// registry tick after a start (60 s by default) and its reload, which mounts
// the entities whose state arrived late.
const TOPOLOGY_SETTLE_MS = 90_000;
// Prefix of the stored topology signature, changes with what it covers.
const TOPOLOGY_FORMAT = "v3:";
const TOPOLOGY_RETRIES = 3;
// A failed write retries soon, the set already settled before it.
const TOPOLOGY_RETRY_MS = 10_000;

export function bumpConfigurationVersion(
  server: ServerNode,
  log: Pick<Logger, "info">,
) {
  return async (change: () => Promise<unknown>) => {
    await server.act("topology change", (agent) =>
      agent.get(BasicInformationServer).increaseConfigurationVersion(change),
    );
    log.info(
      `Matter topology changed, ConfigurationVersion is now ${server.stateOf(BasicInformationServer).configurationVersion}`,
    );
  };
}

// The endpoint set under parent: the aggregator in bridge mode, the root node
// in server mode.
export class TopologyTracker {
  handler = async (change: () => Promise<unknown>) => {
    await change();
  };
  // The handler writes the Matter configuration version, which takes a
  // synchronous lock on the root node. Two overlapping registrations would
  // make the second one throw and leave its endpoint mounted but untracked,
  // so plugin device adds, closes and deletes and the compare go through here
  // one at a time. HA entity changes in a refresh and isolations do not, they
  // run one at a time on refreshChain.
  private queue: Promise<unknown> = Promise.resolve();
  // Last set a reconcile saw, so only a reconcile that moved it re-arms.
  private reconciledSet = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  // a retry after a failed write must not bump the version a second time
  private announced = "";
  private retries = 0;

  // known: whether the set is complete, comparing earlier would announce a
  // half set on every start
  constructor(
    private readonly parent: Endpoint,
    private readonly known: () => boolean,
    private readonly log: Logger,
  ) {}

  async enqueue(run: () => Promise<unknown>): Promise<void> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    await next;
  }

  async change(change: () => Promise<unknown>): Promise<void> {
    try {
      await this.enqueue(change);
    } finally {
      this.settle();
    }
  }

  // After a trusted reconcile: only one that moved the set re-arms.
  reconciled(): void {
    const signature = this.signature();
    if (signature === this.reconciledSet) return;
    this.reconciledSet = signature;
    this.settle();
  }

  stop(): void {
    this.reconciledSet = "";
    clearTimeout(this.timer);
    this.retries = 0;
  }

  // Every change re-arms the timer, so a start that passes through partial
  // sets (late states, #450 retry, #498 cleanup, area switches) compares once.
  settle(retry = false): void {
    if (!retry) this.retries = 0;
    if (!this.known()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.enqueue(() => this.compare());
      },
      retry ? TOPOLOGY_RETRY_MS : TOPOLOGY_SETTLE_MS,
    );
    this.timer.unref?.();
  }

  // Ids, endpoint numbers and Descriptor device types, child parts included,
  // so a rebuild under the same id with another number or device type counts
  // as a change (#543). Strict throws on an unreadable part, so a compare
  // retries it before hashing it blank, a passing read failure would bump the
  // version twice otherwise.
  signature(strict = false): string {
    const lines: string[] = [];
    const walk = (parts: Iterable<Endpoint>, prefix: string) => {
      for (const part of parts) {
        const id = `${prefix}${part.id}`;
        // an uninitialized or crashed part throws here, it must not fail
        // the whole refresh, so it counts with no device types
        let number: number | string = "";
        let types: string[] = [];
        try {
          number = part.number;
          types = part
            .stateOf(DescriptorServer)
            .deviceTypeList.map((d) => `${d.deviceType}.${d.revision}`)
            .sort();
        } catch (e) {
          if (strict) throw e;
        }
        lines.push(`${id}#${number}=${types.join(",")}`);
        walk(part.parts, `${id}/`);
      }
    };
    walk(this.parent.parts, "");
    const hash = createHash("sha256")
      .update(lines.sort().join("\n"))
      .digest("hex")
      .slice(0, 16);
    return `${TOPOLOGY_FORMAT}${hash}`;
  }

  // ConfigurationVersion has to move when the set of bridged endpoints does.
  // The last announced set lives in the node storage, so a restart with the
  // same endpoints announces nothing and a changed one announces once (#505).
  async compare(): Promise<void> {
    // a stop that began after the timer fired leaves a half unmounted set, a
    // running refresh a half applied one. The next reconcile re-arms.
    if (!this.known()) {
      this.reconciledSet = "";
      return;
    }
    try {
      const signature = this.signature(this.retries < TOPOLOGY_RETRIES);
      const storage = this.parent.env
        .get(ServerNodeStore)
        .storage.createContext("hamh");
      const announced = await storage.get<string>("topology", "");
      if (announced === signature) return;
      // a first run only records the set, the version starts fresh anyway.
      // An older format counts as a first run, an upgrade must not bump.
      if (
        announced.startsWith(TOPOLOGY_FORMAT) &&
        this.announced !== signature
      ) {
        await this.handler(async () => undefined);
        this.announced = signature;
      }
      await storage.set("topology", signature);
      this.announced = "";
      this.retries = 0;
    } catch (e) {
      this.log.warn("Failed to announce the bridge topology change:", e);
      if (this.retries < TOPOLOGY_RETRIES) {
        this.retries++;
        this.settle(true);
      } else {
        this.log.warn(
          "Giving up on the bridge topology announcement until the endpoints change again",
        );
      }
    }
  }
}
