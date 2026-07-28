# Home-Assistant-Matter-Hub

!["Home-Assistant-Matter-Hub"](/img/hamh-logo-small.png)

---

> **Community Fork** - This is a fork of the original [t0bst4r/home-assistant-matter-hub](https://github.com/t0bst4r/home-assistant-matter-hub), which was discontinued in January 2026. We continue active development with bug fixes, new features, and community support.
>
> We actively work on fixing old issues from the original project and welcome new feature requests. This is a living project maintained by the community!

---

This project simulates bridges to publish your entities from Home Assistant to any Matter-compatible controller like
Alexa, Apple Home or Google Home. Using Matter, those can be connected easily using local communication without the need
of port forwarding etc.

---

## Known issues and limitations

### Device Type Support

This project does not yet support all available device types in the matter specification.
In addition, controllers like Alexa or Google Home do not support all device types, too.

To check which types are supported, please review the
[list of supported device types](./supported-device-types.md).

### Alexa

- Alexa cannot pair with a bridge which has too many devices attached. It seems to have a limit of
  about 80-100 devices
- Alexa needs at least one Amazon device which supports Matter to pair with a Matter device.
  If you only have a third party smart speaker which supports Alexa, this isn't enough.

### Google Home

- Google Home needs an actual Google Hub to connect a Matter device. Just using the GH app isn't enough.
- Google Home can deny the Matter device under certain conditions because it is not a certified Matter
  device. You need to follow
  [this guide](https://github.com/project-chip/matter.js/blob/main/docs/ECOSYSTEMS.md#google-home-ecosystem)
  to register your hub.

### Network setup

The Matter protocol is designed to work best with UDP and IPv6 within your local network. At the moment some
manufacturers built their controllers to be compatible with IPv4, too, but this can break at any time with any update.

Many users report connection issues when using VLANs or firewalls, where HAMH and the assistant devices (Alexa, Google
Home, ...) are not placed in the same network segment. Please make sure to review the
[common connectivity issues](./guides/connectivity-issues.md).

## What's New

<details>
<summary><strong>📦 Stable (v2.0.49) - Current</strong></summary>

**New in v2.0.49:**

- 🌀 **Fan speed restore**: speed is remembered across transactions and restarts, localized wind presets map through, Auto is gated on a real auto preset, and an opt-in restores speed on power-on ([#387](https://github.com/RiDDiX/home-assistant-matter-hub/issues/387))
- 📡 **Session recovery hardening**: subscription jitter dropped, superseded sessions of a reconnecting peer swept, stale sessions closed only after a real quiet period, plus opt-in fast recovery ([#386](https://github.com/RiDDiX/home-assistant-matter-hub/issues/386), [#400](https://github.com/RiDDiX/home-assistant-matter-hub/issues/400), [#398](https://github.com/RiDDiX/home-assistant-matter-hub/issues/398), [#287](https://github.com/RiDDiX/home-assistant-matter-hub/issues/287))
- 🩺 **Per-fabric controller health card** on the bridge page
- 🔢 **Endpoint number kept on mapping change** so Alexa no longer re-adds the device ([#404](https://github.com/RiDDiX/home-assistant-matter-hub/issues/404)), plus a **unique-id suffix** to shed stale controller records ([#385](https://github.com/RiDDiX/home-assistant-matter-hub/issues/385))
- 🔘 **`select` as an On/Off Switch** ([#356](https://github.com/RiDDiX/home-assistant-matter-hub/issues/356)), plus an **experimental mounted On/Off** control type ([#380](https://github.com/RiDDiX/home-assistant-matter-hub/issues/380))
- 🪟 **Tilt for `set_tilt_position`-only covers** ([#405](https://github.com/RiDDiX/home-assistant-matter-hub/issues/405)), and **tilt-only cover-as-light** uses the tilt channel ([#350](https://github.com/RiDDiX/home-assistant-matter-hub/issues/350))
- 🚨 **Warns on a non-5540 Alexa bridge** ([#401](https://github.com/RiDDiX/home-assistant-matter-hub/issues/401)) and on an **OTBR Thread mDNS interface** ([#388](https://github.com/RiDDiX/home-assistant-matter-hub/issues/388))
- 📷 **Camera plugin config scoped per bridge** ([#373](https://github.com/RiDDiX/home-assistant-matter-hub/issues/373))
- 🔌 **Clashing bridge port reassigned on load** ([#378](https://github.com/RiDDiX/home-assistant-matter-hub/issues/378))
- 🧩 **Composed sub-entities compose even outside the bridge filter** ([#408](https://github.com/RiDDiX/home-assistant-matter-hub/issues/408)), and **composed sensors list all device types** ([#214](https://github.com/RiDDiX/home-assistant-matter-hub/issues/214))
- 🔒 **Unbolt maps to `lock.unlock`** not open ([#397](https://github.com/RiDDiX/home-assistant-matter-hub/issues/397)), **level-to-brightness uses one scale** ([#402](https://github.com/RiDDiX/home-assistant-matter-hub/issues/402)), **button drops the Lighting feature** ([#182](https://github.com/RiDDiX/home-assistant-matter-hub/issues/182)), and **stale cooling/auto state is cleared** ([#384](https://github.com/RiDDiX/home-assistant-matter-hub/issues/384))
- 🌍 **Russian translations** added ([#409](https://github.com/RiDDiX/home-assistant-matter-hub/issues/409)) and **zh-TW completed**

**Previously in v2.0.48:**

- 🌡️ Cooling-only thermostats no longer drop and re-pair after a switch to cool; a leftover Heat setpoint limit was crashing init ([#381](https://github.com/RiDDiX/home-assistant-matter-hub/issues/381))
- 📝 The Settings update box now shows the full release notes instead of cutting them off

**Previously in v2.0.47:**

- 💧 Leak and freeze `binary_sensor`s now default to a Matter 1.3 **Contact Sensor** so Alexa stays stable; the Matter 1.4 Water Leak, Water Freeze, and Rain detector types are selectable per entity through the device-type override ([#365](https://github.com/RiDDiX/home-assistant-matter-hub/issues/365))
- 💡 **Lights no longer auto-attach power/energy clusters**; map a light's power or energy sensor explicitly with `powerEntity`/`energyEntity` if you want the readout ([#374](https://github.com/RiDDiX/home-assistant-matter-hub/issues/374))
- 🔘 The **On/Off Switch** device-type override now exposes a real On/Off Light instead of a no-op plug ([#380](https://github.com/RiDDiX/home-assistant-matter-hub/issues/380))
- 🔍 New **`manufacturer` entity-filter matcher** ([#382](https://github.com/RiDDiX/home-assistant-matter-hub/issues/382))
- 🌀 Opt-in: turning the **companion fan** off now turns the AC off too ([#309](https://github.com/RiDDiX/home-assistant-matter-hub/issues/309))
- 🩺 **Reliability & health**: configurable auto-recovery with failure timestamps, controller-compatibility warnings on each bridge page, and per-entity device-health on the dashboard
- 🖥️ **Standalone (non-vacuum) devices in server mode**, plus `lawn_mower` entities exposed as a robotic mower
- 🪟 Cover exposed as a **dimmable light** for Alexa routines ([#372](https://github.com/RiDDiX/home-assistant-matter-hub/issues/372)), per-entity **update throttle** ([#351](https://github.com/RiDDiX/home-assistant-matter-hub/issues/351)), **charging-state sensor** mapping ([#377](https://github.com/RiDDiX/home-assistant-matter-hub/issues/377))
- 📷 Experimental built-in **WebRTC camera plugin** (SmartThings-only, media path not verified yet)
- 🧵 **matter.js 0.17.7**

**Previously in v2.0.46:**

- ❄️ Opt-in **companion fan** for climate ACs: a per-entity toggle exposes the AC's fan as its own Matter fan endpoint, the setting is persisted, and fan-speed presets are now ordered low→high ([#309](https://github.com/RiDDiX/home-assistant-matter-hub/issues/309))
- 🌦️ **Weather domain support**: `weather.*` entities are exposed as a composed Temperature + Humidity + Pressure sensor read from the entity's attributes (pressure converted to hPa, shown on Google Home)
- 🤖 **Vacuum service-area editing**: edit area data inline in Entity Mapping and dispatch room cleaning in batches, plus a batch-room-data fix ([#291](https://github.com/RiDDiX/home-assistant-matter-hub/issues/291))
- 🔒 **Door Lock credential hardening**: safer access-code handling and fabric-index casting on the lock cluster ([#313](https://github.com/RiDDiX/home-assistant-matter-hub/issues/313))
- ⚡ **Skip unchanged endpoints on HA updates**: only endpoints whose entity or a mapped sub-entity actually changed are refreshed, so CPU no longer scales with entity count × event rate ([#351](https://github.com/RiDDiX/home-assistant-matter-hub/issues/351))
- 🔌 **Registry stays resilient when HA drops**: an initial reload failure no longer puts the add-on in a restart loop on a flaky HA boot, and a mid-flight "Connection lost" retries once ([#352](https://github.com/RiDDiX/home-assistant-matter-hub/issues/352))
- 🔁 **RVC sessions refreshed safely** so vacuum reactors don't go stale ([#287](https://github.com/RiDDiX/home-assistant-matter-hub/issues/287))
- 🪟 **Tilt-only covers** use the tilt channel for lift commands ([#350](https://github.com/RiDDiX/home-assistant-matter-hub/issues/350))
- 🔋 **Battery auto-mapping narrowed** to avoid false matches, plus support for enum battery states ([#359](https://github.com/RiDDiX/home-assistant-matter-hub/issues/359))
- 🔘 **`automation` entities are momentary**: turning one on triggers it and snaps back to off ([#364](https://github.com/RiDDiX/home-assistant-matter-hub/issues/364))
- 🌀 **Climate swing-mode handling fix**
- 🚨 **Non-5540 Alexa bridge warning**: a bridge on any other port now warns, since Alexa only pairs on port 5540
- 🧵 **matter.js 0.17.0**: upgraded from 0.16.11; the local LG-TV NOC-serial patch is dropped because upstream now tolerates 21-octet operational cert serials ([#305](https://github.com/RiDDiX/home-assistant-matter-hub/issues/305))
- 🧰 Build/runtime fixes: `bun:sqlite` `constants` export stubbed so the esbuild bundle builds against matter.js 0.17.0, add-on heap flag preserved ([#358](https://github.com/RiDDiX/home-assistant-matter-hub/issues/358))
- ⬆️ Dependency vulnerabilities resolved
- 📝 Docs: `hvac_action` requirement for the Auto running-state display ([#309](https://github.com/RiDDiX/home-assistant-matter-hub/issues/309)), Google Home ModeSelect label gap ([#356](https://github.com/RiDDiX/home-assistant-matter-hub/issues/356)), Alexa cover-routine limitation ([#312](https://github.com/RiDDiX/home-assistant-matter-hub/issues/312)), and the new weather domain

**Previously in v2.0.45 (hotfix release):**

- ⌨️ Typed text now binds in the entity-id autocomplete, so a partial entity id isn't dropped when you pick a suggestion ([#348](https://github.com/RiDDiX/home-assistant-matter-hub/issues/348))

**Previously in v2.0.44:**

- 🪟 Cover reliability overhaul: Matter state/target/current reports split and correctly ordered, deferred target writes de-duplicated, legacy position attributes dropped from updates, cluster profile aligned with the certified Eve blind, current position held during external motion ([#328](https://github.com/RiDDiX/home-assistant-matter-hub/issues/328))
- 🎚️ Per-bridge and per-entity cover slider debounce, window widened to 300 ms for smoother slider control ([#331](https://github.com/RiDDiX/home-assistant-matter-hub/issues/331))
- 🤖 Vacuum service-area handling: `customServiceAreas` preserved in dynamic `RvcRunMode` supported modes, custom areas dispatched sequentially, `currentArea` cleared on dock return and no longer inherited stale across restarts, `observedCleaning` set on every cleaning event ([#335](https://github.com/RiDDiX/home-assistant-matter-hub/issues/335))
- 🔋 Docked vacuum stops reporting charging once the battery is full ([#334](https://github.com/RiDDiX/home-assistant-matter-hub/issues/334))
- ❄️ Per-entity `climateKeepModeOnIdle` for off+idle ACs; mode kept through a cool→off transition, freeze applied immediately on off and cleared on `action=off` ([#340](https://github.com/RiDDiX/home-assistant-matter-hub/issues/340))
- 🔁 Matter session rotation: opt-in per-bridge setting, aged sessions rotated, RVC clean-mode reactor goes offline correctly, `pushKeepalive` guarded on construction ([#287](https://github.com/RiDDiX/home-assistant-matter-hub/issues/287))
- 🧠 Heap-headroom and force-sync pressure guard to reduce memory pressure ([#347](https://github.com/RiDDiX/home-assistant-matter-hub/issues/347))
- 🏷️ Per-entity `customVendorId` with Home Assistant device-registry serial fallback ([#290](https://github.com/RiDDiX/home-assistant-matter-hub/issues/290))
- 🔢 `serialNumberSuffix` now loads when editing a bridge and is preserved when the serial is trimmed to 32 characters ([#330](https://github.com/RiDDiX/home-assistant-matter-hub/issues/330))
- 🔍 Regex filters for entity and device labels, plus an `any_field_regex` matcher for grouped AND/OR filter rules ([#337](https://github.com/RiDDiX/home-assistant-matter-hub/issues/337))
- ⌨️ Entity-id autocomplete in the filter-rule editor ([#338](https://github.com/RiDDiX/home-assistant-matter-hub/issues/338))
- ⚡ Energy sensor endpoints default `activePower` to 0 and gain `PowerTopology` + `cumulativeEnergyImported` defaults ([#343](https://github.com/RiDDiX/home-assistant-matter-hub/issues/343))
- ⏱️ Home Assistant WebSocket message timeout is now configurable, default raised to 60 s ([#341](https://github.com/RiDDiX/home-assistant-matter-hub/issues/341))
- 🪟 `device_class=window` covers no longer emit `EndProductType.Unknown` ([#312](https://github.com/RiDDiX/home-assistant-matter-hub/issues/312))
- 🖼️ Bridge-icon existence check now uses the `/exists` endpoint instead of a HEAD probe ([#336](https://github.com/RiDDiX/home-assistant-matter-hub/issues/336))
- 🌍 Polish translation update, credited to [@MStankiewiczOfficial](https://github.com/MStankiewiczOfficial) ([#329](https://github.com/RiDDiX/home-assistant-matter-hub/pull/329))

**Previously in v2.0.43:**

- 🤖 Vacuum `currentArea` updates when cleaning is started outside HAMH ([#281](https://github.com/RiDDiX/home-assistant-matter-hub/issues/281))
- 📡 Sensor reactors mark themselves offline when HA disconnects, so updates reach controllers on reconnect ([#327](https://github.com/RiDDiX/home-assistant-matter-hub/issues/327))
- 🪟 Lift+tilt window coverings pick a valid Matter Type ([#323](https://github.com/RiDDiX/home-assistant-matter-hub/issues/323))
- 🪟 Cover `device_class=window` maps to Rollershade ([#312](https://github.com/RiDDiX/home-assistant-matter-hub/issues/312))
- 🧹 UWANT and Xiaomi sweep/mop labels recognised, mop usage routed via `mode.vacuum_mop` ([#322](https://github.com/RiDDiX/home-assistant-matter-hub/issues/322))
- 🤖 Vacuum identify falls back to a sibling identify button when `vacuum.locate` is unsupported ([#320](https://github.com/RiDDiX/home-assistant-matter-hub/issues/320))
- ❄️ HA-auto AC `systemMode` stays put when `hvac_action` is idle, ha-auto-only ACs no longer expose Matter Auto ([#309](https://github.com/RiDDiX/home-assistant-matter-hub/issues/309))
- 🌡️ Climate setpoints snap to the entity `target_temp_step` ([#321](https://github.com/RiDDiX/home-assistant-matter-hub/issues/321))
- 🛰️ matter.js controller traffic captured in `/api/logs`
- 🇯🇵 Japanese translation by [@kimera257](https://github.com/kimera257) ([#325](https://github.com/RiDDiX/home-assistant-matter-hub/pull/325))
- 📝 Docs note for the iPhone-only stuck-on-updating vacuum workaround ([#287](https://github.com/RiDDiX/home-assistant-matter-hub/issues/287))

**Previously in v2.0.42 (hotfix release):**

- 🇯🇵 Aqara bridge registration no longer stalls, root `softwareVersionString` now matches the numeric `softwareVersion` ([#316](https://github.com/RiDDiX/home-assistant-matter-hub/issues/316))
- ❄️ Climate `auto` mode is clamped to `heat`/`cool` on devices without an `AutoMode` base ([#319](https://github.com/RiDDiX/home-assistant-matter-hub/issues/319))
- 🌀 Per-entity `disableClimateFanControl` mapping flag, falls back to `ThermostatDevice` when controllers like Aqara don't recognise `RoomAirConditioner` (`0x0072`) ([#318](https://github.com/RiDDiX/home-assistant-matter-hub/issues/318))
- 🗺️ Vacuum service area `selectedAreas` is kept after dispatch instead of being cleared

**Previously in v2.0.41:**

| Feature | Description |
|---------|-------------|
| 🌡️ Google Home AC offline fix | `DeadFrontBehavior` on climate OnOff cluster so RoomAirConditioner stops showing offline on Google Home ([#302](https://github.com/RiDDiX/home-assistant-matter-hub/issues/302)) |
| 🪟 Cover device_class mapping | Map HA `garage`/`gate`/`window`/`awning`/etc. to the matching Matter WindowCovering type so voice commands hit the right device type ([#304](https://github.com/RiDDiX/home-assistant-matter-hub/issues/304)) |
| 📺 LG TV commissioning patch | Local patch on matter.js 0.16.11 to accept long NOC operational cert serials ([#305](https://github.com/RiDDiX/home-assistant-matter-hub/issues/305)) |
| 💡 Alexa brightness-reset behind flag | Old Alexa brightness-reset heuristic moved behind `alexaPreserveBrightnessOnTurnOn`, default off, Apple Home "set room to 100%" works again ([#306](https://github.com/RiDDiX/home-assistant-matter-hub/issues/306)) |
| 🌀 Google Home fan speed | Uses `fan.set_percentage` so already-on fans pick up speed changes from Google Home ([#308](https://github.com/RiDDiX/home-assistant-matter-hub/issues/308)) |
| ❄️ Climate auto mode | Expose Matter Auto mode when HA reports `auto` in `hvac_modes` ([#309](https://github.com/RiDDiX/home-assistant-matter-hub/issues/309)) |
| 🆔 Server-mode root identity | Root identity now applies as a single transaction, so controllers don't drop devices mid-swap ([#311](https://github.com/RiDDiX/home-assistant-matter-hub/issues/311)) |
| 🪟 Lift-only blinds | No more `TiltBlindTiltOnly` on covers without tilt, fixes Alexa routines for roller blinds ([#312](https://github.com/RiDDiX/home-assistant-matter-hub/issues/312)) |
| 🏷️ Per-entity `disableClimateOnOff` | Turn off the OnOff cluster on climate endpoints per entity for controllers that prefer mode-only control |
| 🔢 `serialNumberSuffix` per bridge | Append a suffix to every entity serial, useful if controllers like Aqara cache stale device data |
| 📝 `protocolLogLevel` option | Quiet matter.js logs independently from the app log level |
| 🖥️ Bridge HW/SW version strings | HA device-registry `hw_version`/`sw_version` now show up in Matter BasicInformation on server-mode endpoints |
| 🎨 Extended color light: XY + enhancedColorMode | XY feature added as mandatory, `enhancedColorMode` mirrors `colorMode` |
| 🎭 Groups + Scenes | Scenes and Groups clusters added on light, plug, and fan endpoints |
| 💧 Boolean state configuration | Cluster added on leak, freeze, rain, and contact sensors |
| 🌍 Spanish translation | New `es` locale ([#314](https://github.com/RiDDiX/home-assistant-matter-hub/pull/314), thanks [@Yllelder](https://github.com/Yllelder)) |
| 🧵 Matter.js 0.16.11 (pinned) | Kept pinned, local NOC serial patch applied |
| ⬆️ Dep bumps | Vite 8, jsdom 29, MUI x-tree-view 9, i18next 26, react-i18next 17, TypeScript 6.0.3, biome pinned 2.4.3, pnpm overrides for transitive CVEs |

**Reliability & resilience:** parallel bridge stop in `stopAll`/`restartAll`, parallel HA registry fetches, serialized bridge start/stop lifecycle, serialized `updateStates` with plugin listener detach, HA reconnect retry on transient network errors, 30s timeout on `sendMessagePromise`, port-conflict reject on web-api start, graceful shutdown on `/api/backup/restart`, `AppEnvironment` disposal on SIGINT, stale optimistic state sweep, pending debouncer clear, healthcheck 401 fix under basic auth, deep-equal entity attribute comparison, overlap guard for auto-refresh, safer mireds conversion, aligned `colorMode` publishing, surfaced bridge import errors, corrected thermostat running state for unknown modes + drying, unified Node version across Dockerfiles, sourcemaps excluded from npm tarball, unused deps dropped (rxjs, strip-color, lodash), unused `config-validator` utility removed.

**Previously in v2.0.39 & v2.0.40 (hotfix releases):**
- Fixed crash loop on startup caused by Node 22 native WebSocket dropping connections ([#297](https://github.com/RiDDiX/home-assistant-matter-hub/issues/297), [#299](https://github.com/RiDDiX/home-assistant-matter-hub/issues/299)), affects both aarch64 (RPi) and amd64
- Fixed service initialization errors being silently swallowed, causing the process to hang instead of exiting
- Registry fetch now waits for WebSocket reconnect between retries and has increased retry tolerance
- Fixed `select`, `input_select`, `siren` domains showing as unsupported in filter preview ([#298](https://github.com/RiDDiX/home-assistant-matter-hub/issues/298))

**Previously in v2.0.38:**

| Feature | Description |
|---------|-------------|
| **🏷️ Per-Entity Identity Overrides** | `customProductName`, `customVendorName`, `customSerialNumber` per entity mapping ([#277](https://github.com/RiDDiX/home-assistant-matter-hub/issues/277), [#290](https://github.com/RiDDiX/home-assistant-matter-hub/issues/290)) |
| **🪟 Garage & Gate Open/Close** | Discrete Open/Close mode for garage and gate covers ([#55](https://github.com/RiDDiX/home-assistant-matter-hub/issues/55)) |
| **🚿 Dishwasher Device Type** | Dishwasher override for switch entities |
| **🚨 Siren Support** | Siren domain as OnOff Plug-in Unit |
| **🏷️ productNameFromNodeLabel Flag** | Report node label as Matter productName for Aqara controllers |
| **🤖 Vacuum Room Progress** | Dynamic room progress tracking via `currentRoomEntity` sensor |
| **⚡ Startup Force Sync** | Immediate force sync on startup to beat stale Alexa queues ([#282](https://github.com/RiDDiX/home-assistant-matter-hub/pull/282)) |
| **🌐 Network Diagnostic API** | mDNS/network diagnostic endpoint with dashboard card |
| **🔌 Energy on Composed Devices** | Energy/power measurement clusters on composed endpoints |
| **🩺 Multi-Admin Fabric Diagnostics** | Per-fabric session info in health API |
| **🩺 Docker HEALTHCHECK** | Native healthcheck in standalone and addon images |
| **🔒 Admin Password Hashing** | Admin password stored hashed, `timingSafeEqual` for lock PIN verification |
| **🧵 Matter.js 0.16.11** | Updated Matter stack |
| **🌍 Polish + Traditional Chinese** | New `pl` and `zh-tw` locales |

**Fix highlights:** vacuum keepalive for Apple Home "Updating…" ([#287](https://github.com/RiDDiX/home-assistant-matter-hub/issues/287)), multi-phase clean progress ([#281](https://github.com/RiDDiX/home-assistant-matter-hub/issues/281)), GenericSwitch single/multi split for Apple Home buttons ([#289](https://github.com/RiDDiX/home-assistant-matter-hub/issues/289)), HA restart attribute guards ([#286](https://github.com/RiDDiX/home-assistant-matter-hub/issues/286)), fan speed restore on turn-on ([#275](https://github.com/RiDDiX/home-assistant-matter-hub/issues/275)), moisture sensor auto-map to HumiditySensor ([#273](https://github.com/RiDDiX/home-assistant-matter-hub/issues/273)), TV speaker override ([#293](https://github.com/RiDDiX/home-assistant-matter-hub/issues/293)), rain + radon sensor auto-mapping, composed sub-endpoint cleanup.

**Previously in v2.0.36:**

| Feature | Description |
|---------|-------------|
| **🏗️ User-Defined Composed Devices** | Create custom composed devices via composedEntities mapping ([#220](https://github.com/RiDDiX/home-assistant-matter-hub/issues/220)) |
| **🔌 Plugin Domain Mappings** | Domain mapping support in plugin API with cloud-mock example |
| **🔋 Valve & Pump Battery** | Battery support for valve and pump endpoints |
| **🌐 German + Russian Translations** | Complete German translation and new Russian language |
| **📡 Session Recovery** | Graceful session close, dead session cleanup, mDNS re-announcement ([#266](https://github.com/RiDDiX/home-assistant-matter-hub/issues/266)) |
| **🔗 Quick Link to Failed Devices** | Dashboard quick link to failed devices ([#270](https://github.com/RiDDiX/home-assistant-matter-hub/issues/270)) |
| **🌡️ Thermostat Fix** | Skip climate.turn_on when already on ([#269](https://github.com/RiDDiX/home-assistant-matter-hub/issues/269)) |
| **🪟 Cover Fix** | Correct stale targetPosition during external movement ([#268](https://github.com/RiDDiX/home-assistant-matter-hub/issues/268)) |
| **🌬️ Air Purifier Fix** | Sub-endpoints for composed air purifier, manual temp/humidity mapping ([#265](https://github.com/RiDDiX/home-assistant-matter-hub/issues/265)) |
| **🔥 Cooling-Only Thermostat Fix** | Prevent HeatingOnly on cooling-only thermostat ([#264](https://github.com/RiDDiX/home-assistant-matter-hub/issues/264)) |
| **↔️ Per-Entity Cover Swap** | Individual coverSwapOpenClose per cover ([#263](https://github.com/RiDDiX/home-assistant-matter-hub/issues/263)) |

</details>

<details>
<summary><strong>🧪 Alpha (v2.1.0-alpha.x)</strong></summary>

**Alpha is currently level with Stable (v2.0.49).** All alpha work up to the latest pre-release has been promoted into v2.0.49. New alpha work continues from the next pre-release tag onward and will appear here as development progresses. See the [Alpha Features Guide](./guides/alpha-features.md) for installation instructions.

</details>

<details>
<summary><strong>📋 Previous Versions</strong></summary>

### v2.0.40
Filter preview domain fix, `select`, `input_select`, `siren` now show as supported ([#298](https://github.com/RiDDiX/home-assistant-matter-hub/issues/298))

### v2.0.39
Node 22 WebSocket crash loop fix ([#297](https://github.com/RiDDiX/home-assistant-matter-hub/issues/297), [#299](https://github.com/RiDDiX/home-assistant-matter-hub/issues/299)), service init error surfacing, registry retry hardening, support link added

### v2.0.37
Aqara productNameFromNodeLabel flag, Matter.js 0.16.11, Swedish locale update

### v2.0.35
HA 2026.3 Clean Area Support, Valetudo Identifier Mapping, Plugin System Hardening, Registry Fingerprint Fix, Roomba Battery Fix, Contact Sensor Fix, Script Momentary Fix, Docusaurus Docs

### v2.0.34
Automatic Backup, Vacuum Battery Auto-Map, Deprecated Feature Flags Fix

### v2.0.33
Endpoint Number Preservation, Binary Sensor Battery Auto-Map

### v2.0.32
Multi-Language Support, Plugin System, New Device Types (PIR, Rain, Electrical, AQ Sensors), Cluster Diagnostics, Dashboard Enhancements, Mapping Profile Export/Import, Fan & Air Purifier Fixes, Stale Session Cleanup, KNX Cover Fix

### v2.0.31
Controller Profiles & Area Setup, Fan Speed/Preset Fix, Optimistic State Fix, Cover Target Fix, Humidity Auto-Mapping Default

### v2.0.30
Mapped Entity Propagation Fix, API Error Surfacing

### v2.0.29
Light currentLevel Fix, Bridge Config Save Fix, Fan Device Feature Fix, Humidity Auto-Mapping Fix

### v2.0.28
Device Image Support, Custom Fan Speed Mapping, TV Source Selection, Reverse Proxy Base Path, On/Off-Only Fans, Light Brightness Fix, Fan Speed Fixes, Composed Air Purifier Fix, Dreame Multi-Floor Fix, Optimistic State Updates, Frontend Improvements

### v2.0.27
Valetudo support, Custom Service Areas, ServiceArea Maps, Vacuum Identify/Locate/Charging, Alarm Control Panel, Composed Air Purifier, Dashboard Controls, Vendor Brand Icons, Thermostat fixes, Air Purifier oscillation/wind

### v2.0.26
Authentication UI, Select entity support, Webhook event bridge, Cluster diagnostics, Matter.js 0.16.10, Docker Node 22, vacuum cleaning mode fallback, vacuum entity filter fix

### v2.0.25
Vacuum mop intensity, vacuum auto-detection, Roborock room auto-detect, live entity mapping, dynamic heap sizing, multi-fabric commissioning, fan speed label fix

### v2.0.24
Dashboard landing page, composed devices, bridge wizard feature flags, entity autocomplete, light transitions, live diagnostics, vacuum suction level, thermostat auto-resume, vacuum docked state, memory leak fix

### v2.0.19-v2.0.23
Bridge templates, live filter preview, entity diagnostics, multi-bridge bulk operations, entity health indicators, diagnostic export, EntityLabel/DeviceLabel filters, Power & Energy Measurement, Event domain (GenericSwitch)

### v2.0.17 / v2.0.18
Room Label (FixedLabel), thermostat overhaul, lock unlatch/unbolt, binary sensor fix, auto pressure mapping, vacuum fixes, dead session recovery, network map, mobile UI, Labels & Areas page, crash resilience, memory limit

### v2.0.16
Force Sync, Lock PIN, Cover/Blinds improvements, Roborock Rooms, Auto Entity Grouping, Water Heater, Vacuum Server Mode, OOM fix

### v1.10.4
Climate/Thermostat fixes, Cover position fix, Vacuum battery, Humidifier improvements, Entity Mapping, Alexa brightness preserve

### v1.9.0
Custom bridge icons, Basic Video Player (TV), Alexa deduplication, Auto-only thermostat, Health Check API, WebSocket, Full backup/restore

### v1.8.x
Graceful crash handler, PM2.5/PM10 sensors, Water Valve, Smoke/CO Detector, Pressure/Flow sensors, Air Purifier, Pump device

### v1.7.x
Dark Mode toggle, Device list sorting

### v1.5.x
Matter Bridge, Multi-Fabric support, Health Monitoring, Bridge Wizard, AirQuality sensors, Fan control, Media playback

</details>

## Getting started

To get things up and running, please follow the [installation guide](./getting-started/installation.md).

## Additional Resources

If you need more assistance on the topic, please have a look at the following external resources:

### Videos

#### YouTube-Video on "HA Matter HUB/BRIDGE 😲 👉 Das ändert alles für ALEXA und GOOGLE Nutzer" (🇩🇪)

[![HA Matter HUB/BRIDGE 😲 👉 Das ändert alles für ALEXA und GOOGLE Nutzer](https://img.youtube.com/vi/yOkPzEzuVhM/mqdefault.jpg)](https://www.youtube.com/watch?v=yOkPzEzuVhM)

#### YouTube-Video on "Alexa et Google Home dans Home Assistant GRATUITEMENT grâce à Matter" (🇫🇷)

[![Alexa et Google Home dans Home Assistant GRATUITEMENT grâce à Matter](https://img.youtube.com/vi/-TMzuHFo_-g/mqdefault.jpg)](https://www.youtube.com/watch?v=-TMzuHFo_-g)

## Support the Project

> **This is completely optional!** The project will continue regardless of donations.
> I maintain this in my free time because I believe in open source and helping the community.

If you find this project useful and want to support its development, consider buying me a coffee! ☕

[![PayPal](https://img.shields.io/badge/PayPal-Donate-blue?logo=paypal)](https://www.paypal.me/RiDDiX93)

Maintaining this project takes time and effort - from fixing bugs, adding new features, to helping users in issues.
Your support is appreciated but never expected. Thank you for using Home-Assistant-Matter-Hub! ❤️
