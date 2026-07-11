<div align="center">

# Home-Assistant-Matter-Hub

!["Home-Assistant-Matter-Hub"](./docs-site/static/img/hamh-logo-small.png)

**Expose your Home Assistant devices to Matter controllers like Apple Home, Google Home, and Alexa**

[![GitHub Release](https://img.shields.io/github/v/release/RiDDiX/home-assistant-matter-hub?label=stable&color=green)](https://github.com/RiDDiX/home-assistant-matter-hub/releases)
[![GitHub Pre-Release](https://img.shields.io/github/v/release/RiDDiX/home-assistant-matter-hub?include_prereleases&label=alpha&color=orange)](https://github.com/RiDDiX/home-assistant-matter-hub/releases)
[![GitHub Issues](https://img.shields.io/github/issues/RiDDiX/home-assistant-matter-hub)](https://github.com/RiDDiX/home-assistant-matter-hub/issues)
[![GitHub Stars](https://img.shields.io/github/stars/RiDDiX/home-assistant-matter-hub)](https://github.com/RiDDiX/home-assistant-matter-hub/stargazers)
[![License](https://img.shields.io/github/license/RiDDiX/home-assistant-matter-hub)](LICENSE)

[📖 Documentation](https://riddix.github.io/home-assistant-matter-hub) • [� Discord](https://discord.gg/Kubv7sSGyW) • [�🐛 Report Bug](https://github.com/RiDDiX/home-assistant-matter-hub/issues/new?labels=bug) • [💡 Request Feature](https://github.com/RiDDiX/home-assistant-matter-hub/issues/new?labels=enhancement)

</div>

---

> [!NOTE]
> 🔀 **Community Fork** - This is a fork of the original [t0bst4r/home-assistant-matter-hub](https://github.com/t0bst4r/home-assistant-matter-hub), which was discontinued in January 2026. We continue active development with bug fixes, new features, and community support. Thank you **[@t0bst4r](https://github.com/t0bst4r)** for the original work! ❤️
>
> **📦 Migrating?** See [Migration Guide](#migration-from-t0bst4r) - your paired devices will continue to work!

---

## 📝 About

This project simulates bridges to publish your entities from Home Assistant to any Matter-compatible controller like
Alexa, Apple Home or Google Home. Using Matter, those can be connected easily using local communication without the need
of port forwarding etc.

---

## 📦 Releases & Branches

| Channel | Branch | Current Version | Description |
|---------|--------|-----------------|-------------|
| **Stable** | `main` | v2.0.48 | Production-ready, recommended for most users |
| **Alpha** | `alpha` | v2.1.0-alpha.x (next) | Currently level with Stable; next pre-release lands here first |
| **Testing** | `testing` | v4.1.0-testing.x | ⚠️ **Highly unstable!** Experimental features, may break |

### Which version should I use?

- **Most users**: Use **Stable** (`main` branch) - thoroughly tested
- **Early adopters**: Use **Alpha** (`alpha` branch) - currently level with Stable until the next pre-release lands
- **Developers/Testers**: Use **Testing** (`testing` branch) - bleeding edge, expect breakage

### Upgrading from 2.0.46

A few entities re-pair once on the first start after the update and lose their room assignment in the controller:

- leak and freeze `binary_sensor`s (now Contact Sensors by default) and any entity using the **On/Off Switch** override
- a light may drop its auto power/energy readout, re-add it by mapping the sensor by hand

Re-assign the affected devices to their rooms after they reconnect. See the [docs](https://riddix.github.io/home-assistant-matter-hub/supported-device-types) for detail.

---

## 🎉 What's New

<details>
<summary><strong>📦 Stable Features (v2.0.48)</strong> - Click to expand</summary>

**New in v2.0.48:**

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
- 🧵 **matter.js 0.17.3**

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
- 🧩 JSON editor de-duplicates `@codemirror/state` ([#345](https://github.com/RiDDiX/home-assistant-matter-hub/issues/345))
- 🌍 Polish translation update, credited to [@MStankiewiczOfficial](https://github.com/MStankiewiczOfficial) ([#329](https://github.com/RiDDiX/home-assistant-matter-hub/pull/329))
- ✅ Added regression test coverage for the session-max-age parser ([#287](https://github.com/RiDDiX/home-assistant-matter-hub/issues/287))
- ⬆️ Dependency hygiene: transitive deps flagged by Dependabot patched, `serialize-javascript` bumped to 7.0.5 in docs-site

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
<summary><strong>🧪 Alpha Features (v2.1.0-alpha.x)</strong> - Click to expand</summary>

**Alpha is currently level with Stable (v2.0.46).** All alpha work up to the latest pre-release has been promoted into v2.0.46. New alpha work continues from the next pre-release tag onward and will appear here as development progresses.

</details>

<details>
<summary><strong>⚠️ Testing Features (v4.1.0-testing)</strong> - Click to expand</summary>

> [!CAUTION]
> Testing versions are **highly unstable** and intended for developers only!

**🏗️ Vision 1: Callback-based Architecture**

| Old (Legacy) | New (Vision 1) |
|--------------|----------------|
| Behaviors update themselves | Endpoint updates behaviors via `setStateOf()` |
| Behaviors call HA actions directly | Behaviors notify via `notifyEndpoint()` |

**New Callback-Behaviors:** OnOff, LevelControl, Lock, Cover, Fan, ColorControl, VacuumRunMode, VacuumOperationalState

**Updated Endpoints:** Switch, Lock, Cover, Vacuum, Button, Valve, Scene, Humidifier, Light, Fan

</details>

<details>
<summary><strong>📜 Previous Stable Versions</strong> - Click to expand</summary>

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

---

## Supported Device Types

| Home Assistant Domain | Matter Device Type | Feature Flags |
|-----------------------|-------------------|---------------|
| `light` | On/Off, Dimmable, Color Temp, Extended Color | `powerEntity`, `energyEntity` (no longer auto-mapped, set explicitly if a light's energy readout disappears, [#374](https://github.com/RiDDiX/home-assistant-matter-hub/issues/374)), `coverExposeAsDimmableLight` ([#372](https://github.com/RiDDiX/home-assistant-matter-hub/issues/372)) |
| `switch`, `input_boolean` | On/Off Plug-in Unit | `powerEntity`, `energyEntity` |
| `lock` | Door Lock | PIN Credentials, Unlatch/Unbolt |
| `cover` | Window Covering | `coverSwapOpenClose` |
| `climate` | Thermostat | Battery via `batteryEntity`, `climateExposeFan` ([#309](https://github.com/RiDDiX/home-assistant-matter-hub/issues/309)) |
| `fan` | Fan, Air Purifier | Oscillation, Wind Modes, `filterLifeEntity` |
| `alarm_control_panel` | Mode Select | Arm/Disarm modes |
| `binary_sensor` | Contact, OnOff, Occupancy, Smoke/CO | Leak/freeze default to Contact Sensor (Alexa-safe); the Matter 1.4 Water Leak/Freeze and Rain detector types are per-entity overrides ([#365](https://github.com/RiDDiX/home-assistant-matter-hub/issues/365)) |
| `sensor` | Temperature, Humidity, Pressure, Flow, Light, AirQuality | `batteryEntity`, `humidityEntity`, `pressureEntity` |
| `event` | Generic Switch (Doorbell, Button Events) | |
| `button`, `input_button` | Generic Switch | |
| `media_player` | Speaker, Basic Video Player (TV) | |
| `valve` | Water Valve, Pump | |
| `select`, `input_select` | Mode Select | |
| `vacuum` | Robot Vacuum Cleaner | `serverMode`, `roomEntities`, `batteryEntity`, `cleaningModeEntity`, `suctionLevelEntity`, `mopIntensityEntity`, `customServiceAreas`, `vacuumMinimalClusters`, `chargingStateEntity` ([#377](https://github.com/RiDDiX/home-assistant-matter-hub/issues/377)) |
| `lawn_mower` | Robotic Lawn Mower (RVC-based) | reuses the robot-vacuum flags ([#301](https://github.com/RiDDiX/home-assistant-matter-hub/issues/301)) |
| `humidifier` | Humidifier/Dehumidifier | |
| `water_heater` | Thermostat (Heating) | |
| `automation`, `script`, `scene` | On/Off Switch | The per-entity "On/Off Switch" override now produces a real `0x0100` On/Off Light (controllers render a switch), needs a one-time re-pair, and no longer carries power/energy fields ([#380](https://github.com/RiDDiX/home-assistant-matter-hub/issues/380)) |

> 📖 See [Supported Device Types Documentation](https://riddix.github.io/home-assistant-matter-hub/supported-device-types) for details

**Common per-entity flags:** `updateThrottleMs` rate-limits how often an entity pushes updates to controllers ([#351](https://github.com/RiDDiX/home-assistant-matter-hub/issues/351)), `coverExposeAsDimmableLight` exposes a cover as a dimmable light for Alexa routines ([#372](https://github.com/RiDDiX/home-assistant-matter-hub/issues/372)), `chargingStateEntity` maps a charging-state sensor ([#377](https://github.com/RiDDiX/home-assistant-matter-hub/issues/377)), `climateExposeFan` exposes a climate AC's fan as its own endpoint ([#309](https://github.com/RiDDiX/home-assistant-matter-hub/issues/309)).

### Entity Filters

Filter rules match on these matcher types: `pattern`, `regex`, `domain`, `platform`, `entity_label`, `device_label`, `entity_label_regex`, `device_label_regex`, `any_field_regex`, `area`, `entity_category`, `device_name`, `product_name`, `device_class`. The new **`manufacturer`** matcher matches the device manufacturer (or `default_manufacturer`) and supports `*` wildcards ([#382](https://github.com/RiDDiX/home-assistant-matter-hub/issues/382)).

### Reliability & Health

Configurable auto-recovery with failure timestamps in Settings, controller-compatibility warnings on each bridge page, per-entity device-health diagnostics on the health dashboard, and a warning when a bridge exposes device types its controller does not support.

### Experimental: Camera Plugin

A built-in plugin exposes Home Assistant cameras as Matter Cameras (`0x0142`). Experimental, SmartThings-only as of 2026, and the WebRTC media path is not verified end to end.

---

## 🤖 Robot Vacuum Server Mode

<details>
<summary><strong>⚠️ Important: Apple Home & Alexa require Server Mode for Robot Vacuums</strong> (click to expand)</summary>

### The Problem

Apple Home and Alexa **do not properly support bridged robot vacuums**. When your vacuum is exposed through a standard Matter bridge, you may experience:

- **Apple Home**: "Updating" status, Siri commands don't work, room selection fails
- **Alexa**: Vacuum is not discovered at all

This is because these platforms expect robot vacuums to be **standalone Matter devices**, not bridged devices.

### The Solution: Server Mode

**Server Mode** exposes a device as a standalone (non-bridged) Matter endpoint without the bridge wrapper. It works for any device type, not just vacuums, and a bridge can host standalone devices. For a robot vacuum this makes it fully compatible with Apple Home and Alexa.

### Setup Instructions

1. **Create a new bridge** in the Matter Hub web interface
2. **Enable "Server Mode"** checkbox in the bridge creation wizard
3. Add **only your vacuum** to this bridge
4. **Pair the new Server Mode bridge** with Apple Home or Alexa
5. Your other devices stay on your regular bridge(s)

### Important Notes

- A Server Mode node exposes each device as a standalone endpoint, up to 10 per node; extra entities are skipped
- For best results give a robot vacuum its own dedicated Server Mode bridge
- Other device types (lights, switches, sensors) also work on regular bridges
- After switching to Server Mode, Siri commands like "Hey Siri, start the vacuum" will work

### Documentation

For more details, see the [Robot Vacuum Documentation](https://riddix.github.io/home-assistant-matter-hub/devices/robot-vacuum).

</details>

---

## Installation

### Home Assistant Add-on (Recommended)

[![Open your Home Assistant instance and show the dashboard of an app.](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=3fd9e6b0_hamh&repository_url=https%3A%2F%2Fgithub.com%2Friddix%2Fhome-assistant-addons)

### Manual steps (testing versions, etc.)
Add this repository to your Add-on Store:

```
https://github.com/RiDDiX/home-assistant-addons
```

Two add-ons are available:
- **Home-Assistant-Matter-Hub** - Stable release
- **Home-Assistant-Matter-Hub (Alpha)** - Pre-release for testing

### Docker

```bash
docker run -d \
  --name home-assistant-matter-hub \
  --network host \
  -v /path/to/data:/data \
  -e HAMH_HOME_ASSISTANT_URL=http://192.168.178.123:8123 \
  -e HAMH_HOME_ASSISTANT_ACCESS_TOKEN=your_long_lived_access_token \
  ghcr.io/riddix/home-assistant-matter-hub:latest
```

> **Note:** All environment variables require the `HAMH_` prefix.
> See the [Installation Guide](https://riddix.github.io/home-assistant-matter-hub/getting-started/installation) for all available options.

For alpha versions, use tag `alpha` instead of `latest`.

---

## Documentation

Please see the [documentation](https://riddix.github.io/home-assistant-matter-hub) for detailed installation instructions,
configuration options, known issues, limitations and guides.

---

## 🔧 Network Troubleshooting

<details>
<summary><strong>⚠️ "No Response" / Connection Drops, Common Network Causes</strong> (click to expand)</summary>

### The Problem

Your Matter devices suddenly show **"No Response"** (Apple Home), **"Unavailable"** (Google Home), or become **unresponsive** after some time, even though the bridge is still running and other controllers (e.g., Alexa) continue to work fine.

### Root Cause: Network Equipment Blocking mDNS/Multicast

Matter relies heavily on **mDNS (multicast DNS)** for device discovery and reachability. Many routers, access points, and managed switches have features that **filter, throttle, or block multicast traffic**, which breaks Matter communication silently.

> **💡 This was confirmed and documented thanks to the excellent systematic testing by [@omerfaruk-aran](https://github.com/omerfaruk-aran) in [#129](https://github.com/RiDDiX/home-assistant-matter-hub/issues/129).** The issue was traced to a TP-Link Archer AX50 (in AP mode) sitting between the Apple TV and the network, its default settings were blocking/limiting mDNS/Bonjour traffic over time.

### What to Check on Your Network Equipment

1. **IGMP Snooping**, Disable or configure it to allow mDNS (`224.0.0.251` / `ff02::fb`)
2. **Multicast Optimization / Multicast Enhancement**, Disable (often called "Airtime Fairness" or "Multicast to Unicast")
3. **AP Isolation / Client Isolation**, Must be **disabled** so devices on the same network can communicate
4. **mDNS / Bonjour Forwarding**, Enable if available (some enterprise APs have this)
5. **DHCP Server on secondary devices**, Disable DHCP on access points / switches that are NOT your main router (multiple DHCP servers cause IP conflicts)
6. **Firmware Updates**, Update your router/AP firmware, as multicast handling is frequently improved

### Affected Equipment (Known Cases)

| Device | Issue | Fix |
|--------|-------|-----|
| **TP-Link Archer AX50** (AP mode) | mDNS traffic blocked/limited over time | Firmware update + disable DHCP on the AP |
| **Ubiquiti UniFi APs** | IGMP Snooping can filter mDNS | Disable IGMP Snooping or enable mDNS Reflector |
| **Managed Switches** (various) | Multicast filtering enabled by default | Allow mDNS multicast groups |

### Quick Diagnostic Steps

1. **Does Alexa still work when Apple Home shows "No Response"?**
   - **Yes** → Bridge is online, the issue is network path / mDNS related
   - **No** → Bridge may actually be down, check HAMH logs

2. **Does removing a Home Hub (HomePod/Apple TV) fix it?**
   - **Yes** → The hub's network path is affected (AP/switch between hub and bridge)
   - **No** → May be a different issue

3. **Try binding mDNS to a specific interface:**
   ```
   --mdns-network-interface eth0
   ```
   (or `end0`, `enp0s18`, etc., check your system)

### Network Topology Tips

- **Keep the path simple**: Avoid placing access points or managed switches between your Matter bridge (Home Assistant) and your Home Hub (HomePod/Apple TV)
- **Use wired connections** where possible for Home Hubs and the Home Assistant host
- **Same subnet**: All Matter devices, controllers, and the bridge must be on the same Layer 2 network / subnet
- **IPv6**: Matter requires IPv6, do not disable it. For VLAN setups, configure **ULA addresses** (`fd00::/8`), not just link-local (`fe80::`). See [Troubleshooting](https://riddix.github.io/home-assistant-matter-hub/guides/connectivity-issues#ipv6) and [Discussion #39](https://github.com/RiDDiX/home-assistant-matter-hub/discussions/39)

</details>

---

## Migration from t0bst4r

Migrating from the original `t0bst4r/home-assistant-matter-hub` is easy. **Your Matter fabric connections and paired devices will be preserved!**

### Home Assistant Add-on

1. **Backup your data:**
   ```bash
   cp -r /addon_configs/*_hamh /config/hamh-backup
   # Verify the backup was copied correctly
   ls /config/hamh-backup
   ```

2. **Uninstall the old add-on** (Settings → Add-ons → Uninstall) and make sure the old folder is removed:
   ```bash
   rm -rf /addon_configs/*_hamh
   ```

3. **Add the new repository:**
   ```
   https://github.com/RiDDiX/home-assistant-addons
   ```

4. **Install and start the new add-on once** (creates the data folder), then **stop it**

5. **Clear the new folder and restore your backup:**
   ```bash
   rm -rf /addon_configs/*_hamh/*
   cp -r /config/hamh-backup/* /addon_configs/*_hamh/
   ```

6. **Start the add-on again** - your devices should reconnect automatically

### Docker / Docker Compose

Simply change the image from:
```
ghcr.io/t0bst4r/home-assistant-matter-hub:latest
```
to:
```
ghcr.io/riddix/home-assistant-matter-hub:latest
```

Your volume mounts stay the same - no data migration needed.

> For detailed instructions, see the [full Migration Guide](https://riddix.github.io/home-assistant-matter-hub/migration-from-t0bst4r/).

---

## 🙏 Contributors & Acknowledgments

This project thrives thanks to the amazing community! Special thanks to everyone who contributes by reporting bugs, suggesting features, and helping others.

> Note: GitHub doesn't surface contributors on this repo because it's still a fork of the original. The list below is maintained by hand.

### 🏆 Top Contributors

Newest first.

| Contributor | Contributions |
|-------------|---------------|
| [@qbattersby](https://github.com/qbattersby) | 🤖 **Code Contributor** - LevelControl transitionTime patch for matter.js 0.17, so Google Home can dim already-on lights ([#383](https://github.com/RiDDiX/home-assistant-matter-hub/pull/383)) |
| [@Yllelder](https://github.com/Yllelder) | 🌐 **Translator** - Spanish translation ([#314](https://github.com/RiDDiX/home-assistant-matter-hub/pull/314)) |
| [@MStankiewiczOfficial](https://github.com/MStankiewiczOfficial) | 🌐 **Translator** - Polish translation ([#288](https://github.com/RiDDiX/home-assistant-matter-hub/pull/288), [#329](https://github.com/RiDDiX/home-assistant-matter-hub/pull/329)) |
| [@aetasoul](https://github.com/aetasoul) | 🤖 **Code Contributor** - Immediate force sync on startup to beat stale Alexa queues ([#282](https://github.com/RiDDiX/home-assistant-matter-hub/pull/282)) |
| [@omerfaruk-aran](https://github.com/omerfaruk-aran) | 🌐 Turkish translation ([#260](https://github.com/RiDDiX/home-assistant-matter-hub/pull/260)) + 🔧 Network debugging for "No Response" issues ([#129](https://github.com/RiDDiX/home-assistant-matter-hub/issues/129)) |
| [@gustavakerstrom](https://github.com/gustavakerstrom) | 🤖 **Code Contributor** - Custom fan speed mapping ([#226](https://github.com/RiDDiX/home-assistant-matter-hub/pull/226)), template description fix ([#215](https://github.com/RiDDiX/home-assistant-matter-hub/pull/215)) |
| [@AmineDjeghri](https://github.com/AmineDjeghri) | 📝 Migration instructions for the addon data folder ([#171](https://github.com/RiDDiX/home-assistant-matter-hub/pull/171)) |
| [@markgaze](https://github.com/markgaze) | 🤖 **Code Contributor** - Ecovacs Deebot room support ([#118](https://github.com/RiDDiX/home-assistant-matter-hub/pull/118)) |
| [@codyc1515](https://github.com/codyc1515) | 🥇 **Top Reporter** - Climate/thermostat bugs (#52, #24, #21, #20), README badge & install steps ([#285](https://github.com/RiDDiX/home-assistant-matter-hub/pull/285)), binary sensor classes ([#66](https://github.com/RiDDiX/home-assistant-matter-hub/pull/66)), fan control init ([#10](https://github.com/RiDDiX/home-assistant-matter-hub/pull/10)) |
| [@AymericLeFeyer](https://github.com/AymericLeFeyer) | 📝 README YouTube video link |
| [@depahk](https://github.com/depahk) | 📝 Migration docs ([#32](https://github.com/RiDDiX/home-assistant-matter-hub/pull/32)) |
| [@Hatton920](https://github.com/Hatton920) | 🤖 **Vacuum Expert** - Intensive testing of Robot Vacuum Server Mode, Apple Home & Siri validation |
| [@razzietheman](https://github.com/razzietheman) | 🥈 **Active Tester** - Bridge icons (#101), sorting (#80), feature requests (#31, #30), extensive UI/UX feedback |
| [@SH1FT-W](https://github.com/SH1FT-W) | 💎 **Sponsor** + Vacuum room selection feature request (#49) |
| [@Chrulf](https://github.com/Chrulf) | 🔍 Google Home brightness debugging (#41), detailed logs & testing |
| [@Fettkeewl](https://github.com/Fettkeewl) | 🐛 Script import bug (#26), Alias feature request (#25) |

<details>
<summary><strong>📋 Issue Tracker - All Contributors</strong> (click to expand)</summary>

Thank you to everyone who helps improve this project by reporting issues!

| User | Issues |
|------|--------|
| [@omerfaruk-aran](https://github.com/omerfaruk-aran) | #129 |
| [@markgaze](https://github.com/markgaze) | #118 |
| [@BlairC1](https://github.com/BlairC1) | #117 |
| [@Giamp96](https://github.com/Giamp96) | #116 |
| [@NdR91](https://github.com/NdR91) | #115 #106 |
| [@Fry7](https://github.com/Fry7) | #114 |
| [@siobhanellis](https://github.com/siobhanellis) | #112 |
| [@Hatton920](https://github.com/Hatton920) | #110 |
| [@gette](https://github.com/gette) | #95 |
| [@400HPMustang](https://github.com/400HPMustang) | #103 |
| [@vandir](https://github.com/vandir) | #102 |
| [@razzietheman](https://github.com/razzietheman) | #101 #100 #80 #31 #30 |
| [@seitenprofi](https://github.com/seitenprofi) | #176 |
| [@semonR](https://github.com/semonR) | #99 #58 |
| [@italoc](https://github.com/italoc) | #78 |
| [@marksev1](https://github.com/marksev1) | #62 |
| [@smacpi](https://github.com/smacpi) | #60 |
| [@mrbluebrett](https://github.com/mrbluebrett) | #53 |
| [@anpak](https://github.com/anpak) | #45 |
| [@alondin](https://github.com/alondin) | #43 |
| [@Chrulf](https://github.com/Chrulf) | #41 |
| [@Weske90](https://github.com/Weske90) | #40 |
| [@didiht](https://github.com/didiht) | #37 |
| [@Dixiland20](https://github.com/Dixiland20) | #34 |
| [@chromaxx7](https://github.com/chromaxx7) | #29 |
| [@Tomyk9991](https://github.com/Tomyk9991) | #28 |
| [@datvista](https://github.com/datvista) | #27 |
| [@bwynants](https://github.com/bwynants) | #23 |
| [@Pozzi831](https://github.com/Pozzi831) | #22 |
| [@codyc1515](https://github.com/codyc1515) | #52 #24 #21 #20 |

</details>

### 💖 Sponsors

> **Donations are completely voluntary!** This project exists because of passion for open source, not money. Thank you to everyone who has supported it, it truly means a lot! ❤️

🥇 **First Sponsor:** [@thorsten-gehrig](https://github.com/thorsten-gehrig)

| | | |
|---|---|---|
| 💎 [@SH1FT-W](https://github.com/SH1FT-W) | 💎 [@ilGaspa](https://github.com/ilGaspa) | 💎 [@linux4life798](https://github.com/linux4life798) |
| 💎 [@torandreroland](https://github.com/torandreroland) | 💎 [@ralondo](https://github.com/ralondo) | 💎 [@bexxter85-ux](https://github.com/bexxter85-ux) |
| 💎 [@dinariox](https://github.com/dinariox) | 💎 [@JRCondat](https://github.com/JRCondat) | 💎 [@d3rby91](https://github.com/d3rby91) |
| 💎 [@nicoodeimos](https://github.com/nicoodeimos) | 💎 [@ustari28](https://github.com/ustari28) | 💎 Markus Müller ([@Dingosworld](https://github.com/Dingosworld)) |
| 💎 StefanS | 💎 Manny B. | 💎 Bonjon |
| 💎 TobiR | 💎 Franz Huber | 💎 Michele Larese de Prata |
| 💎 [@CNCB](https://github.com/CNCB) | 💎 [@pelican1997](https://github.com/pelican1997) | 💎 [@PeJanNL](https://github.com/PeJanNL) |
| 💎 [@bra1nbuster](https://github.com/bra1nbuster) | 💎 [@knuti1960](https://github.com/knuti1960) | 💎 [@ppttu](https://github.com/ppttu) |

🙏 *...and anonymous supporters who prefer not to be named.*

### 🌟 Original Author

- **[@t0bst4r](https://github.com/t0bst4r)** - Creator of the original Home-Assistant-Matter-Hub project

---

## ☕ Support the Project

> [!NOTE]
> **Completely optional!** This project will continue regardless of donations.
> I maintain this in my free time because I believe in open source.

If you find this project useful, consider supporting its development:

[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Donate-ea4aaa?logo=githubsponsors&style=for-the-badge)](https://github.com/sponsors/RiDDiX)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Donate-ff5e5b?logo=kofi&logoColor=white&style=for-the-badge)](https://ko-fi.com/riddix)
[![PayPal](https://img.shields.io/badge/PayPal-Donate-blue?logo=paypal&style=for-the-badge)](https://www.paypal.me/RiDDiX93)

Your support helps cover hosting costs and motivates continued development. Thank you! ❤️

---

## 📊 Project Stats

<div align="center">

![GitHub commit activity](https://img.shields.io/github/commit-activity/m/RiDDiX/home-assistant-matter-hub)
![GitHub last commit](https://img.shields.io/github/last-commit/RiDDiX/home-assistant-matter-hub)
![GitHub issues](https://img.shields.io/github/issues/RiDDiX/home-assistant-matter-hub)
![GitHub closed issues](https://img.shields.io/github/issues-closed/RiDDiX/home-assistant-matter-hub)
![GitHub pull requests](https://img.shields.io/github/issues-pr/RiDDiX/home-assistant-matter-hub)

</div>

---

