---
description: Actively maintained fork and successor of t0bst4r/home-assistant-matter-hub. Expose Home Assistant devices to Matter controllers like Apple Home, Google Home, and Alexa.
keywords:
  - home-assistant-matter-hub
  - t0bst4r
  - fork
  - successor
  - matter bridge
  - hamh
---

# Home-Assistant-Matter-Hub

!["Home-Assistant-Matter-Hub"](/img/hamh-logo-small.png)

---

> **Community Fork** - This is the actively maintained fork and successor of [t0bst4r/home-assistant-matter-hub](https://github.com/t0bst4r/home-assistant-matter-hub), which was discontinued in January 2026 and has since been archived. We continue active development with bug fixes, new features, and community support. The Home Assistant add-on slugs are `hamh` (stable), `hamh-alpha` and `hamh-testing`.
>
> We actively work on fixing old issues from the original project and welcome new feature requests. This is a living project maintained by the community! Coming from the original? See the [fork comparison](./getting-started/fork-comparison.md) and the [migration guide](./getting-started/migration-from-t0bst4r.md).

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
<summary><strong>📦 Stable (v2.0.56) - Current</strong></summary>

**New in v2.0.56:**
- 🔋 **Vacuum battery after HA 2026.8**: integrations that moved the battery to a separate sensor are picked up as the sensor appears, a missing percentage reports an unknown charge state instead of "charging forever", and terminal states like "not charging" stop counting as charging ([#450](https://github.com/RiDDiX/home-assistant-matter-hub/issues/450))
- 💡 **RGB-only lights pass controller conformance again**: the Extended Color Light always advertises the full mandatory feature set, which brings WLED and similar lights back to Alexa ([#452](https://github.com/RiDDiX/home-assistant-matter-hub/issues/452))
- 🌫️ **PM2.5, PM10 and CO₂ sensor overrides**: map a single-pollutant sensor to an Air Quality Sensor endpoint carrying just that concentration cluster via the Entity Mapping UI (Aqara renders them, Alexa partially)
- 🇰🇷 **Korean translation** by [@hyeok-yoo](https://github.com/hyeok-yoo) ([#455](https://github.com/RiDDiX/home-assistant-matter-hub/pull/455))
- 🔀 Debounced commands no longer swallow an explicit on/off that arrives next to a level or color change ([#453](https://github.com/RiDDiX/home-assistant-matter-hub/pull/453))
- 🌡️ Thermostats write their absolute limits before the user limits, so a flat heat range can no longer trip the range check on bring-up ([#454](https://github.com/RiDDiX/home-assistant-matter-hub/issues/454))
- 🪟 Cover end product type follows the feature map: a tilting curtain or shade reports the matching tilting product, a lift-only blind stops claiming InteriorBlind (follow-up to [#304](https://github.com/RiDDiX/home-assistant-matter-hub/issues/304))
- 🔍 **Three Alexa pairing diagnostics, off by default**: `advertiseSpecVersion151`, `supportTermsAndConditions` and `enableMatterTcp`, for Echos that stop right after the attestation step ([#449](https://github.com/RiDDiX/home-assistant-matter-hub/issues/449))
- 🧹 Session supervision and entity mapping sync now live in shared code instead of two near-identical copies per bridge flavour; no behavior change

**Previously in v2.0.55:**
- 🔗 Devices keep their Matter numbers when Home Assistant restarts, so controllers stop re-adding everything and losing groups and routines ([#438](https://github.com/RiDDiX/home-assistant-matter-hub/issues/438))
- 🔌 One plugin device no longer stalls every state update on its bridge, and plugin devices stop vanishing a minute after a refresh ([#445](https://github.com/RiDDiX/home-assistant-matter-hub/issues/445))
- 🚫 A command that cannot reach Home Assistant now fails instead of reporting success, so a cover no longer shows a position it never reached ([#446](https://github.com/RiDDiX/home-assistant-matter-hub/issues/446))
- 💡 Identify presses the identify button of the device, on everything rather than vacuums alone ([#447](https://github.com/RiDDiX/home-assistant-matter-hub/issues/447))
- 🌡️ Climate power-on reaches the device even when the cached state lags ([#441](https://github.com/RiDDiX/home-assistant-matter-hub/issues/441))
- 🌀 Fan speed zero picks the slowest mode the entity really has, and fan sliders can be debounced so bridged air conditioners stop beeping ([#442](https://github.com/RiDDiX/home-assistant-matter-hub/issues/442), [#443](https://github.com/RiDDiX/home-assistant-matter-hub/issues/443))
- 🎚️ Number feature flags render as number inputs, so the cover and fan debounce settings are reachable in the UI at last
- 🤝 A controller that is still being interviewed is no longer disconnected halfway, which could abort commissioning
- 📷 Camera devices carry the bridged information every device under a bridge needs ([#155](https://github.com/RiDDiX/home-assistant-matter-hub/issues/155))

**Previously in v2.0.54 (hotfix release):**
- 🔌 Plugin disable now sticks across restarts, for the security and camera plugins alike
- 👻 An unconfigured security plugin exposes no devices anymore; updating removes the ghost plugs
- 🔁 Disabling a plugin removes its devices immediately, re-enabling keeps their identity

**Previously in v2.0.53:**

- 🛡️ **Security plugin (experimental)**: the bridge becomes a small alarm system with Home/Away/Night/Vacation switches you arm from any controller or by voice, entry/exit delays, trigger and alert lists; for setups without an alarm integration
- 🤖 **Vacuum room switches**: opt-in per-room switches that controller routines can flip, an opt-in ascending room order for batch cleaning, and auto-resolved rooms survive state updates ([#355](https://github.com/RiDDiX/home-assistant-matter-hub/issues/355), [#368](https://github.com/RiDDiX/home-assistant-matter-hub/issues/368))
- 🔌 **Plugin settings dialog**: configure plugins right on the Plugins page; config survives restarts, stored secret fields are redacted from the plugin listing, and the page explains server mode instead of failing ([#432](https://github.com/RiDDiX/home-assistant-matter-hub/issues/432))
- 🔔 **Doorbell and electrical utility meter overrides**: opt-in Matter 1.4 device types for `event` entities and consumption sensors; SmartThings renders them, defaults stay unchanged
- 🚿 **Water heater management**: opt-in Matter 1.4 Water Heater with Boost/CancelBoost on top of the heating thermostat, for energy-management controllers ([#437](https://github.com/RiDDiX/home-assistant-matter-hub/pull/437))
- 🌀 **Fan modes follow the entity**: controllers are only offered the speeds and modes the HA fan actually accepts, no more phantom Medium or Auto ([#436](https://github.com/RiDDiX/home-assistant-matter-hub/pull/436))
- 🌡️ **heat_cool thermostats no longer crash-loop the add-on**: the auto deadband is zeroed, single-mode setpoints ignore the parked range, and an endpoint that still fails is contained instead of exiting ([#435](https://github.com/RiDDiX/home-assistant-matter-hub/issues/435))
- 🔒 **Lock stops re-adding itself**: a stale flag written by v2.0.7-v2.0.16 failed lock init on every start, so the lock re-paired as a new device each boot; it is cleared on load ([#433](https://github.com/RiDDiX/home-assistant-matter-hub/discussions/433))
- 💡 **Google room-off no longer relights dimmable lights**: the level Google sends after "turn off" is stored for the next turn-on instead of being applied ([#434](https://github.com/RiDDiX/home-assistant-matter-hub/issues/434))
- 🪟 **Cover stuck-moving paths closed**: the remaining cases that kept a cover reported as moving are fixed, and resolved cover flags are logged ([#429](https://github.com/RiDDiX/home-assistant-matter-hub/issues/429))
- 🔌 **Plugin devices receive controller writes again**: a wiring gap dropped attribute writes on the way to plugin devices
- 🧵 **matter.js 0.17.9**
- 📊 **Fork comparison page**: the docs compare this fork with the archived t0bst4r upstream, feature by feature

**Previously in v2.0.52 (hotfix release):**

- 🔌 The plugins page no longer fails with a 500 when a server mode bridge exists ([#430](https://github.com/RiDDiX/home-assistant-matter-hub/issues/430))

**Previously in v2.0.51:**

- 🐕 **Opt-in wedge watchdog**: rotates a controller session that keeps acking but stops talking at the interaction layer, the automated "Play Sound" fix for stuck Apple devices ([#287](https://github.com/RiDDiX/home-assistant-matter-hub/issues/287), [#428](https://github.com/RiDDiX/home-assistant-matter-hub/issues/428))
- 🧹 **Clean up orphaned records**: bridge menu action with a dry-run preview that removes identity and mapping leftovers of entities deleted from HA (7 day tombstone guards against false positives)
- 🚗 **EV charger support**: new EVSE device-type override with charging switch and current limit mapping, EnableCharging/Disable from the controller; Aqara and Home Assistant render it, keep it off Alexa bridges
- 🩺 **Subscription scope on the health card**: see whether each controller holds a whole-node wildcard or watches specific endpoints
- 📷 **Camera live view signaling completed**: the WebRTC answer now reaches the controller over the requestor cluster, plus full media path logging, HA signaling timeouts, trickle ICE and ICE server support (still experimental until verified on real hardware)
- 🪟 **Cover stop detection in every position space**: the v2.0.50 cover fix now also works with the Alexa percentage flag and the per-cover swap toggle, and swapped covers report the right direction ([#429](https://github.com/RiDDiX/home-assistant-matter-hub/issues/429))
- 🤖 **Vacuum on/off crash fixed**: state updates no longer throw on vacuums with the on/off toggle ([#428](https://github.com/RiDDiX/home-assistant-matter-hub/issues/428))
- 🌍 **Brazilian Portuguese completed**: 602 of 615 strings ([#420](https://github.com/RiDDiX/home-assistant-matter-hub/issues/420))

**Previously in v2.0.50:**

- 🆔 **Stable device identity (opt-in)**: endpoints keep their identity when an entity is renamed or re-registered, keyed on the HA registry unique id; enable the `stableIdentity` feature flag per bridge ([#404](https://github.com/RiDDiX/home-assistant-matter-hub/issues/404), [#407](https://github.com/RiDDiX/home-assistant-matter-hub/issues/407))
- ⚡ **Energy suite stage 1**: consumption sensors expose an **Electrical Meter** that Google Home and SmartThings render, home batteries become a **Battery Storage** device with signed charge/discharge power and lifetime energy, and voltage/current/energy sensors group onto one endpoint via new mapping fields
- 🪟 **Covers report their own movement**: controllers get the moving-to-stopped edge even when the integration never reports opening/closing, clears the stuck "Opening" on Echo Show ([#429](https://github.com/RiDDiX/home-assistant-matter-hub/issues/429)), and discrete commands cancel a pending slider action ([#411](https://github.com/RiDDiX/home-assistant-matter-hub/issues/411))
- 🧙 **Commissioning preflight in the wizard**: port, mDNS and controller checks with fix-it buttons before the QR code, plus a label guard and an empty-filter block
- 🔋 **Per-entity "Disable battery mapping"** switch ([#427](https://github.com/RiDDiX/home-assistant-matter-hub/issues/427))
- 🧩 **Auto-grouped sensors read sub-entities past the bridge filter** ([#426](https://github.com/RiDDiX/home-assistant-matter-hub/issues/426))
- 📡 **mDNS records refresh when interface addresses change**, recovers Google Home after an IPv6 prefix change ([#415](https://github.com/RiDDiX/home-assistant-matter-hub/issues/415)), and **mDNS IPv4 can be disabled** ([#417](https://github.com/RiDDiX/home-assistant-matter-hub/issues/417))
- 🖥 **Server mode shares the dead-session timeout and session diagnostics** ([#428](https://github.com/RiDDiX/home-assistant-matter-hub/issues/428))
- 🔒 **Per-lock PIN length overrides** and an **opt-in passthrough that programs the physical lock usercode** ([#418](https://github.com/RiDDiX/home-assistant-matter-hub/issues/418))
- 🔘 **Opt-in to suppress the momentary on/off flip for scripts** ([#423](https://github.com/RiDDiX/home-assistant-matter-hub/issues/423))
- 🚨 **Smoke alarms report battery, fault and expressed state** ([#408](https://github.com/RiDDiX/home-assistant-matter-hub/issues/408))
- 💡 **Light level and color-temperature step control** ([#412](https://github.com/RiDDiX/home-assistant-matter-hub/issues/412))
- 📷 **Camera bridges enable Matter-over-TCP** for SmartThings live view, and camera endpoints set the mandatory AV stream attributes ([#419](https://github.com/RiDDiX/home-assistant-matter-hub/issues/419))
- 🔧 **Valve and cover overrides route On/Off to their services** ([#65](https://github.com/RiDDiX/home-assistant-matter-hub/issues/65))
- 🌍 **Brazilian Portuguese** added ([#420](https://github.com/RiDDiX/home-assistant-matter-hub/issues/420))
- 🧵 **matter.js 0.17.9**
- ⬆️ Dependency vulnerabilities resolved (websocket-driver, react-router 8, fast-uri, js-yaml and friends)

**Previously in v2.0.49:**

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
- 🧵 **matter.js 0.17.9**

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

**Alpha is ahead of Stable (v2.0.56).** Everything below ships in the alpha channel now and lands in the next stable promote, grouped by the pre-release tag it first appeared in.

**v2.1.0-alpha.885:**
- 🏷️ **A device renamed in Home Assistant reaches the controller**: an endpoint that survived a refresh kept the registry snapshot it was built with, so a device rename, and its manufacturer, model or firmware version, only showed up after a restart. With `preferEntityRegistryName` on, an entity rename never arrived at all. The snapshot is refreshed on every registry poll now, an entity rename triggers that poll in the first place, and server mode pushes the renamed identity to its root node instead of waiting for a structural change. Note that Apple Home takes the accessory name when the device is added and keeps its own copy afterwards, so a rename shows up there only for accessories you add after it ([#467](https://github.com/RiDDiX/home-assistant-matter-hub/issues/467))

**v2.1.0-alpha.884:**
- 🧩 **A grouped device can announce its own type again**: the parent endpoint of a composed device only said "bridged node", so Apple Home had no device type to read on the accessory and took the icon from one of the grouped entities. A light grouped with a button showed up as an outlet. The new `composedPrimaryOnParent` bridge option puts the primary entity on the parent endpoint, which is the same shape an ungrouped entity has, so the accessory reads as a light and the grouped entities keep their own types. It applies to devices you group yourself with Composed Sub-Entities and needs `autoComposedDevices` on as well, the automatically composed sensors, air purifiers and climate/fan devices are not affected. Off by default because it changes the endpoint layout, so the device has to be removed and added again in the controller, and because an earlier attempt at this shape made Apple Home stop listing the grouped entities ([#469](https://github.com/RiDDiX/home-assistant-matter-hub/issues/469))

**v2.1.0-alpha.883:**
- 🔐 **A controller that refuses the bridge certificates says so in the log now**: pairing that stops right after the attestation step left only a bare "Failed" on the controller and nothing in the HAMH log. The bridge notices that no CSRRequest followed and names the step in its own log. Controllers that only pair with CSA certified products, like the Ambiscape feature on Philips Ambilight TVs, cannot be used at all: HAMH serves matter.js development certificates (test vendor `0xFFF1`, "Matter Test PAA", certification type "test") and no bridge setting changes that ([#465](https://github.com/RiDDiX/home-assistant-matter-hub/issues/465))

**v2.1.0-alpha.882:**
- 🔒 **A lock PIN takes effect immediately**: PIN enforcement was read from an attribute that only refreshed on the next Home Assistant state change, so a PIN added through a controller or the web page was not demanded yet, and a cleared one was still demanded. Both the check and the attribute follow the credential store now
- 👥 **Lock credentials respect Add, Modify and the fabric that created them**: adding over an occupied slot, modifying an empty one, or a second controller replacing a PIN it did not create are refused, matching the Matter rules
- 🛠️ **Programming a physical lock is confirmed before success is reported**: with `lockUsercodeService` set, a code the lock rejected was still reported as programmed, and a failed clear left a working keypad code while the controller was told it was gone
- 💾 **Credential files are read defensively**: a file written by a newer build used to load nothing and then get overwritten with an empty set, losing every stored PIN, and a half migrated file aborted startup

**v2.1.0-alpha.881:**
- 🔒 **Locks reject an empty or overlong PIN**: a controller could program a zero length PIN, which switched remote PIN enforcement on and was then accepted as the PIN itself. SetCredential checks the length against the minimum and maximum the lock advertises now
- ⚡ **PIN hashing no longer stalls the bridge**: every PIN protected unlock hashed on the event loop, which froze all bridges, Matter traffic, mDNS and the Home Assistant connection for the duration. Hashing moved to the thread pool

**v2.1.0-alpha.880:**
- 🪟 **Covers keep their position while a controller is talking to them**: a Home Assistant update that arrived while the controller held the same device was dropped with a warning only, which is what still lost positions after the alpha.879 serialization. Attribute writes wait for the device to be free now instead of being thrown away ([#464](https://github.com/RiDDiX/home-assistant-matter-hub/issues/464))

**v2.1.0-alpha.879:**
- 🧹 **Air purifiers stop rebuilding themselves**: a composed device never listed its battery entity, so the battery auto-map retry rebuilt the endpoint on every sensor update, burning CPU and raising unhandled rejections. A sensor without a device class also needs "batt" in its id now, a filter life percentage is no longer taken for a battery ([#461](https://github.com/RiDDiX/home-assistant-matter-hub/issues/461))
- 🪟 **Covers moved together no longer lose their position**: state writes are serialized per device, two updates in the same millisecond used to collide on the endpoint lock and matter.js dropped the position attributes with a warning only ([#464](https://github.com/RiDDiX/home-assistant-matter-hub/issues/464))
- 💡 **Siri "set to 100%" works next to Alexa**: `alexaPreserveBrightnessOnTurnOn` now only suppresses the brightness reset for commands arriving over the Alexa fabric, before it swallowed the same command from Apple Home ([#460](https://github.com/RiDDiX/home-assistant-matter-hub/issues/460))
- ❄️ **Per-entity `climateForceTurnOn`**: sends `climate.turn_on` on every Matter On command, for IR controlled ACs where Home Assistant can report on while the device is off ([#462](https://github.com/RiDDiX/home-assistant-matter-hub/issues/462))

**v2.1.0-alpha.878:**
- 🪟 **Covers keep the same Matter fingerprint for life**: a cover that had been moved used to come back from a restart advertising an extra attribute it never had when the controller paired it, because matter.js counts movements in a stored attribute that only appears once it is set ([#456](https://github.com/RiDDiX/home-assistant-matter-hub/issues/456))

**v2.1.0-alpha.877:**
- 🧠 **Heap limit is configurable now**: the add-on takes a `heap_size_mb` option, the automatic sizing moved from a quarter to half of the available memory, and a `NODE_OPTIONS` you set yourself is honored instead of being silently overridden ([#459](https://github.com/RiDDiX/home-assistant-matter-hub/issues/459))

**v2.1.0-alpha.876:**
- 🧩 **Third-party plugins load again**: an installed plugin package is imported through its manifest entry point instead of its directory, which Node refuses, and the entry has to resolve inside the package; contributed by Patrick Gu ([#458](https://github.com/RiDDiX/home-assistant-matter-hub/pull/458))
- 🏷️ Plugin devices report their own name to controllers instead of a generic device-type label
- 📣 Adding or removing a plugin device now tells commissioned controllers that the bridge composition changed, so they re-discover it; a restart with unchanged devices stays silent

**v2.1.0-alpha.875:**
- 🚨 **Security plugin can mirror an existing alarm panel**: the new `sourceAlarmPanel` setting turns the four mode switches and the Alarm contact into a Matter view of an `alarm_control_panel.*` entity (Alarmo etc.), with arm and disarm flowing back to Home Assistant; contributed by Patrick Gu ([#457](https://github.com/RiDDiX/home-assistant-matter-hub/pull/457)). Panels that require an alarm code reject the bridge's arm/disarm calls, the switches then fall back to the panel's real state

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
