// matter.js advertises Matter mDNS on every non-loopback interface and bakes
// each interface address into the operational records. On Docker hosts that
// lets controllers latch onto an unreachable Docker-internal address and show
// devices as offline (#361). This classifies the interfaces so HAMH can warn
// and suggest the LAN interface; it never decides binding on its own.

export interface MdnsInterfaceAddrs {
  readonly name: string;
  readonly ipv4: readonly string[];
  readonly ipv6: readonly string[];
}

export interface MdnsInterfaceChoice {
  // The likely LAN interface, when exactly one routable non-Docker interface
  // exists. Only a suggestion for the warning, never bound automatically.
  readonly selected?: string;
  // Routable (non-loopback, non-link-local) external interfaces.
  readonly external: readonly MdnsInterfaceAddrs[];
  // Interfaces whose name looks Docker-internal.
  readonly dockerLike: readonly string[];
  // True when a Docker-internal interface name or a Docker IPv4 range is seen.
  readonly suspicious: boolean;
  // True when an external interface carries a global IPv6 that mDNS would
  // advertise but a controller may not reach on the LAN (#361).
  readonly hasGlobalIpv6: boolean;
  // True when an OpenThread/OTBR interface (wpan*/otbr*) is present. Its
  // mesh-local fd:: ULA gets advertised but controllers cannot route to it.
  readonly hasThreadInterface: boolean;
}

type RawInterfaces = Record<
  string,
  | ReadonlyArray<{ family: string; address: string; internal: boolean }>
  | undefined
>;

// docker0/hassio/veth*/cni* are container-internal. br-* is intentionally NOT
// here: br-lan and friends are common real LAN bridge names.
const DOCKER_NAME = /^(docker\d*|hassio|veth|cni)/;

// wpan0/otbr* are OpenThread border-router interfaces. Their mesh-local fd::
// ULA is not routable off the host, so mDNS must not advertise it (#388).
const THREAD_NAME = /^(wpan|otbr)/;

// 172.16.0.0/12 is the default Docker bridge range.
function inDockerRange(ipv4: string): boolean {
  const parts = ipv4.split(".");
  const second = Number(parts[1]);
  return parts[0] === "172" && second >= 16 && second <= 31;
}

function isLinkLocal(family: string, address: string): boolean {
  if (family === "IPv4") return address.startsWith("169.254.");
  return address.toLowerCase().startsWith("fe80");
}

// fe80::/10 link-local and fc00::/7 ULA IPv6 are reachable on the local link. A
// global IPv6 advertised over mDNS can point a controller at an address it
// cannot reach back on the LAN (#361).
export function isLinkLocalOrUla(address: string): boolean {
  const a = address.toLowerCase();
  return /^fe[89ab]/.test(a) || /^f[cd]/.test(a);
}

export function selectMdnsInterface(raw: RawInterfaces): MdnsInterfaceChoice {
  const external: MdnsInterfaceAddrs[] = [];
  const dockerLike: string[] = [];
  const threadLike: string[] = [];
  for (const [name, addrs] of Object.entries(raw)) {
    if (!addrs) continue;
    const usable = addrs.filter((a) => !a.internal);
    if (usable.length === 0) continue;
    if (DOCKER_NAME.test(name)) dockerLike.push(name);
    if (THREAD_NAME.test(name)) threadLike.push(name);
    const ipv4 = usable
      .filter((a) => a.family === "IPv4")
      .map((a) => a.address);
    const ipv6 = usable
      .filter((a) => a.family === "IPv6")
      .map((a) => a.address);
    const routable = usable.some((a) => !isLinkLocal(a.family, a.address));
    if (!routable) continue;
    external.push({ name, ipv4, ipv6 });
  }
  const lan = external.filter(
    (i) => !DOCKER_NAME.test(i.name) && !THREAD_NAME.test(i.name),
  );
  const selected = lan.length === 1 ? lan[0].name : undefined;
  const suspicious =
    dockerLike.length > 0 || external.some((i) => i.ipv4.some(inDockerRange));
  const hasGlobalIpv6 = external.some((i) =>
    i.ipv6.some((a) => !isLinkLocalOrUla(a)),
  );
  const hasThreadInterface = threadLike.length > 0;
  return {
    selected,
    external,
    dockerLike,
    suspicious,
    hasGlobalIpv6,
    hasThreadInterface,
  };
}
