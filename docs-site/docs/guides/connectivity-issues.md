# Troubleshooting for Network and Hub Connectivity Issues

If you're experiencing connectivity issues with your Matter Hub and voice assistants like Apple Home, Google Home, or
Alexa, follow this guide to address common problems.

:::tip Start with the built-in diagnostics

Open **Health & Diagnostics** in the HAMH web UI. The **Network Diagnostics** card lists every network interface, shows which one mDNS is bound to, and runs automated checks that flag the most common problems (for example mDNS advertising on Docker-internal or extra interfaces) with a direct hint on what to change. It is the fastest way to see what your bridge is actually advertising before you touch any settings.

HAMH logs the same warnings at startup, so the add-on log is a good second place to look. The **Controller Health** card on the same page shows each connected controller and whether its link has gone stale.

:::

## 1. Network Configuration and Firewall Settings

### IPv6

- Ensure **IPv6** is properly configured across your router, host, docker, and (if used) virtual machines. Misconfigured
  IPv6 settings can lead to connectivity issues.

:::warning ULA IPv6 required for VLAN setups

Matter requires IPv6 for device discovery and communication. There are two types of IPv6 addresses relevant here:

- **Link-local** (`fe80::/64`), Auto-assigned on every interface. **Cannot be routed across VLANs or subnets.** Only works when all devices are on the same Layer 2 segment.
- **ULA (Unique Local Address)** (`fd00::/8`), Routable across VLANs within your local network. This is what you need if your Home Assistant and IoT devices are on different VLANs.

If you run a VLAN setup (e.g. Home Assistant in a "Server" VLAN and IoT devices in an "IoT" VLAN), **you must configure ULA IPv6 addresses** on your router. Link-local alone will not work across VLANs.

**How to set up ULA on common routers:**

- **UniFi**: Settings → Networks → (your network) → IPv6 → Enable IPv6 with a `fd00::/48` prefix (Prefix Delegation from WAN is optional and not required for local operation)
- **pfSense / OPNsense**: Interfaces → (your VLAN) → IPv6 Configuration Type → "Track Interface" or "Static IPv6" with a `fd00::/64` prefix
- **Generic routers**: Enable IPv6 with a ULA prefix in your LAN/VLAN settings. Consult your router's documentation.

**Quick verification:**

```bash
# On your Home Assistant host, check for a ULA address (starts with fd):
ip -6 addr show | grep "fd"

# Ping a device on another VLAN using its ULA address:
ping6 fd10::30:xxxx:xxxx:xxxx:xxxx
```

If you only see `fe80::` addresses and no `fd` prefixes, ULA is not configured.

**After changing IPv6 settings** on your router or Home Assistant host, **reboot HAOS** (not just the add-on). The mDNS service reads network addresses at startup and Docker containers may not see interface changes until the host restarts.

HAMH now watches the interface addresses and re-announces with the current set when it changes, so a dynamic ISP IPv6 prefix change no longer leaves controllers stuck on a dead global address. On link-local-only LANs `mdns_strip_global_ipv6` stays the robust choice, since a stripped set never moves when the ISP prefix rotates.

See [Discussion #39](https://github.com/RiDDiX/home-assistant-matter-hub/discussions/39) for a detailed explanation of IPv6 behavior with Matter.

:::

### Firewall & VLAN

UDP, including mDNS, is typically not routed across segmented networks. To ensure proper functionality, UDP traffic must
flow freely between all network segments, and IPv6 must be fully operational across your network.

- Avoid VLAN configurations that may segment your network and isolate devices from each other. Ensure all devices,
  including your mobile device during the pairing process, are on the same network segment for seamless communication.
- If VLAN segmentation is unavoidable:
  - **Ports**: Verify that required ports (e.g., **5353, 5540, 5541** - TCP & UDP) are open and correctly routed.
  - **mDNS Forwarding**: Enable mDNS forwarding to allow communication between devices on different network segments.
  - **Firewall**: Ensure your firewall allows the necessary ports. Temporarily disable the firewall to determine if it
    is causing connectivity issues.

### IGMP Snooping

If not configured properly, IGMP Snooping may cause the suppression of mDNS messages. 
For this reason, it is recommended to disable it on networking devices such as switches and, if applicable, Hypervisors & Access Points.

## 2. Network Equipment Blocking mDNS/Multicast

Many routers, access points, and managed switches have features that **filter, throttle, or block multicast traffic by default**, which silently breaks Matter communication. This is one of the most common causes of intermittent "No Response" or connection drops.

> **💡 Community finding:** This was confirmed through systematic testing by [@omerfaruk-aran](https://github.com/omerfaruk-aran) in [#129](https://github.com/RiDDiX/home-assistant-matter-hub/issues/129). The issue was traced to a TP-Link Archer AX50 (in AP mode) blocking mDNS/Bonjour traffic over time, causing Apple Home to lose reachability while Alexa continued to work fine.

### Symptoms

- Devices show **"No Response"** in Apple Home after some time (minutes to hours)
- Other controllers (e.g., Alexa) **continue to work** during the failure
- The HAMH bridge UI remains online and shows "Running"
- Removing/rebooting a Home Hub (HomePod/Apple TV) temporarily fixes it
- Problem returns after idle periods

### What to Check

| Setting | Action | Why |
|---------|--------|-----|
| **IGMP Snooping** | Disable or allow mDNS groups (`224.0.0.251` / `ff02::fb`) | Can silently filter mDNS multicast |
| **Multicast Optimization** | Disable (also called "Airtime Fairness" or "Multicast to Unicast") | Converts multicast to unicast, breaking mDNS |
| **AP Isolation / Client Isolation** | Must be **disabled** | Prevents devices on the same network from communicating |
| **mDNS / Bonjour Forwarding** | Enable if available | Some enterprise APs require explicit mDNS forwarding |
| **DHCP Server on APs** | Disable on all devices except your main router | Multiple DHCP servers cause IP conflicts and routing issues |
| **Firmware** | Update to latest | Multicast handling is frequently improved in firmware updates |

### Known Affected Equipment

| Device | Issue | Fix |
|--------|-------|-----|
| **TP-Link Archer AX50** (AP mode) | mDNS traffic blocked/limited over time | Firmware update + disable DHCP on the AP ([#129](https://github.com/RiDDiX/home-assistant-matter-hub/issues/129)) |
| **Ubiquiti UniFi APs** | IGMP Snooping can filter mDNS | Disable IGMP Snooping or enable mDNS Reflector |
| **Managed Switches** (various) | Multicast filtering enabled by default | Allow mDNS multicast groups |
| **Mesh Wi-Fi systems** | Some implementations isolate multicast between nodes | Check for multicast/mDNS settings, consider wired backhaul |

### mDNS Network Interface Binding

On a host with several network interfaces, Matter advertises its operational records on **all** of them and writes every interface address into those records. A controller can then latch onto an unreachable address and show devices as **"No Response"** (Apple Home) or **"Offline"** (Google Home), even though pairing succeeded. With Google Home this often looks like the device being found during setup but failing at "connecting to device". A power outage or reboot can trigger it by reshuffling interfaces or addresses.

Interfaces that commonly cause this:

- **Docker bridges** like `docker0`, `hassio`, or `veth*`, and the container's own bridge on a `172.16.x` / `172.30.x` address. Controllers cannot reach these from the LAN.
- **OpenThread / OTBR interfaces** (`wpan0`, `otbr*`) that appear when you also run the Thread Border Router or the official Matter Server add-on. They carry a Thread mesh-local ULA (an `fd::` address) that is not routable to the rest of your network, so a controller that picks it cannot connect.
- A **global IPv6 address** (`2000::/3`) on your LAN NIC that a controller cannot reach back on the local network.

HAMH flags this in two places: the **Network Diagnostics** card on the **Health & Diagnostics** page names the extra interfaces and suggests your likely LAN interface, and the startup log prints the same warning. Bind mDNS to your real LAN interface yourself (**not** a Docker or Thread one):

- **HA OS add-on:** set the `mdns_network_interface` option to the LAN NIC (e.g. `end0`, `eth0`, `enp0s3`), not `docker0`, `hassio`, `veth*`, or `wpan0`.
- **Plain container:** pass `--mdns-network-interface eth1` (your LAN NIC on `192.168.x`), not the Docker bridge (e.g. `eth0` on `172.16.x`), or run the container with `--network=host` (recommended for Matter).

If your LAN interface also carries a global IPv6 that controllers cannot reach, drop it from what mDNS advertises with `mdns_strip_global_ipv6` (add-on, both channels; stable from the next release) or `--mdns-strip-global-ipv6` (container). This keeps only the link-local and ULA addresses. It does **not** remove a Thread `fd::` address, since that is a ULA; for Thread interfaces, bind the LAN interface instead.

If the advertised IPv4 address is unroutable (for example podman without host networking behind an avahi reflector), force controllers onto IPv6 with `mdns_disable_ipv4` (add-on) or `--mdns-disable-ipv4` (container). This stops mDNS advertising IPv4 so only IPv6 is used. Only reach for it when IPv4 is the problem: an IPv6-only advertisement leaves controllers without IPv6 connectivity (some older Alexa or Google Home hubs) unable to discover the bridge.

Check names and addresses with `ip addr`, or read them straight from the Network Diagnostics card. After changing the interface on an add-on, **reboot HAOS** (not just the add-on) so mDNS re-reads addresses, then re-commission the bridge in your controller.

### Network Topology Best Practices

- **Keep the path simple**: Avoid placing access points or managed switches between your Matter bridge (Home Assistant) and your Home Hub (HomePod/Apple TV)
- **Use wired connections** where possible for Home Hubs and the Home Assistant host
- **Same subnet**: All Matter devices, controllers, and the bridge **must** be on the same Layer 2 network / subnet
- **IPv6 enabled**: Matter requires IPv6, do not disable it. For VLAN setups, configure **ULA addresses** (`fd00::/8`), not just link-local (`fe80::`). See [IPv6 section](#ipv6) above.

## 3. Ecosystem and Device Compatibility / Requirements

### Apple Home

- **Home Hub Required**: Apple Home requires a **HomePod** (mini) or **Apple TV** as a Home Hub to maintain persistent Matter connections. Without a hub, the iPhone only maintains the connection while the Home app is active.
- **"No Response" after adding a Home Hub**: If devices become unresponsive after adding a HomePod or Apple TV, this is almost always a network issue, see [Section 2](#2-network-equipment-blocking-mdnsmulticast) above.
- **"Updating" status for Robot Vacuums**: Apple Home requires robot vacuums to be exposed as standalone devices, not bridged. Enable **Server Mode**, see [Robot Vacuum Documentation](../devices/robot-vacuum.md).
- **Phone reboot as a quick fix**: If Apple Home shows "No Response" but Alexa works fine, rebooting your iPhone/iPad can force Apple Home to re-establish subscriptions as a temporary workaround.
- **Apple TV vs. HomePod mini**: Apple TV (4K) generally handles larger bridges better than HomePod mini due to more CPU/RAM. If you have many devices, prefer Apple TV as your primary Home Hub.

### Alexa

- **IPv6 Address Type (GUA vs ULA)**: Alexa requires a locally reachable IPv6 address. If your Home Assistant host has both a **GUA** (Global Unicast, `2xxx::/3`) and a **ULA** (`fd00::/8`) IPv6 address, mDNS may advertise the GUA which Alexa cannot reach on the local network. Remove the GUA from the interface or ensure ULA is configured, then **reboot HAOS** (not just the add-on) so the mDNS service picks up the correct addresses. See [#283](https://github.com/RiDDiX/home-assistant-matter-hub/issues/283).
- **Device Limitations**: Alexa cannot pair with a bridge if too many devices (around 80-100) are already attached.
  Remove unused devices to resolve this limitation.
- **Amazon Device Requirement**: Ensure at least one Amazon device supporting Matter is connected. Third-party
  Alexa-enabled devices (e.g. like Sonos) are insufficient for pairing with Matter devices.

### Google Home

- **Matter Hub Requirements**: Google Home requires a dedicated Matter hub, such as a **Google Nest** or
  **Google Mini**, for Matter integration.
- **Offline Devices**: If Google Home displays devices as "offline":
  - Check that a compatible Google Home device (e.g., Google Home Mini) is connected to your local network.
  - Verify that **IPv6** is correctly set up; issues with IPv6 can lead to offline device indications.
- **Certified Matter Device**: Google Home may reject uncertified Matter devices.
  Follow [this guide](https://github.com/project-chip/matter.js/blob/main/docs/ECOSYSTEMS.md#google-home-ecosystem) to
  register your hub properly with Google Home.

### Duplicate / ghost mDNS records after re-pairing

If you see two `_matter._tcp` instances with the same fabric prefix and one of them fails to resolve, a controller or network cache is still holding a record from an earlier pairing. The bridge is not announcing it, so restarting HAMH will not clear it. Check the **Fabrics** card on the bridge page first: if it really shows 2 fabrics, factory-reset the bridge instead.

To clear a stale record: remove the bridge from the controller, factory-reset the bridge in HAMH, reboot the controller hub (Nest, Apple TV, Echo) and the HA host, then re-pair. An unclean shutdown (power loss, hard kill) skips the mDNS goodbye, so old records linger until their TTL expires.

## 4. Additional Troubleshooting Tips

- **Logs**: Review logs for specific error messages to identify and resolve configuration issues.
- **Consult Resources**: Refer to
  the [Troubleshooting Guide](https://github.com/project-chip/matter.js/blob/main/docs/TROUBLESHOOTING.md)
  and [Known Issues](https://github.com/project-chip/matter.js/blob/main/docs/KNOWN_ISSUES.md) of the matter.js project.

### Automatic recovery

HAMH restarts bridges that failed to start on its own. Only failed bridges are touched, running bridges are never interrupted. Recovery runs on a timer and again right after Home Assistant reconnects, so a short HA outage does not leave a bridge stuck. Turn it off or change the interval under **Settings → Auto recovery**; recent attempts are listed in the Health Dashboard.

### Clean shutdown

On stop or restart, HAMH closes its Matter sessions before exiting, so each controller drops the old session right away instead of holding a stale one. This avoids a controller showing the bridge as unresponsive for a while after a restart.
