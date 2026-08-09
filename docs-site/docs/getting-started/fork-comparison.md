---
description: Side-by-side comparison of the actively maintained RiDDiX fork of home-assistant-matter-hub and the archived t0bst4r upstream project.
keywords:
  - home-assistant-matter-hub
  - t0bst4r
  - fork
  - successor
  - comparison
---

# Fork Comparison: RiDDiX vs t0bst4r

This fork is the actively maintained successor of [t0bst4r/home-assistant-matter-hub](https://github.com/t0bst4r/home-assistant-matter-hub). The original author announced the end of development in January 2026; the upstream repository is archived, its last change dates to March 2026, and it was left with more than 160 open issues. This page compares the two projects factually so you can decide whether to switch. For the how-to, see the [migration guide](./migration-from-t0bst4r.md).

## Project status

| | RiDDiX fork | t0bst4r upstream |
|---|---|---|
| Development | Active, stable and alpha release channels | Archived, read-only since March 2026 |
| Issue tracker | Open, actively triaged | Closed, more than 160 issues left open |
| matter.js | 0.17.9 | 0.16.7 (pinned, no further updates) |
| Home Assistant add-on | `hamh` (stable), `hamh-alpha`, `hamh-testing` | Original add-on, no longer updated |

## Features added in the fork

Everything the upstream project supported still works here; the storage format is compatible in both directions. The rows below are features that exist only in the fork.

| Feature | Status |
|---|---|
| Vacuum room selection (ServiceArea) with opt-in ascending room order | Stable |
| Custom device names per entity | Stable |
| Composed multi-sensor devices (several HA sensors as one Matter device) | Stable |
| Per-device battery mapping (`batteryEntity`) | Stable |
| Server mode: standalone Matter accessories instead of a bridge | Stable |
| Room Air Conditioner device type, incl. dry mode | Stable |
| EV charger (Energy EVSE) | Stable |
| Electrical meter (power and energy measurement clusters) | Stable |
| Battery storage (ESS) | Stable |
| Water heater management (Matter 1.4, opt-in) | Stable |
| Camera plugin (WebRTC live view) | Experimental |
| Stable identity flag (keeps endpoint identity across renames) | Stable |
| Wedge watchdog: rotates sessions gone silent (opt-in) | Stable |
| Per-fabric health card with subscription scope | Stable |
| Manual cleanup of orphaned identity and mapping records | Stable |
| Plugin system with a settings UI per bridge | Stable |
| UI translations: 15 locales, including pt-BR | Stable |
| Doorbell device type | Stable |
| Electrical utility meter device type | Stable |

New device types are opt-in overrides, never a changed default, so an upgrade does not re-compose devices that are already paired.

## Compatibility with upstream

- The Matter storage format is identical. Fabrics pair once and survive the switch in both directions, see [migration](./migration-from-t0bst4r.md) and its rollback section.
- Configuration options from upstream keep working; fork-only options are additive.

## Sources

Feature claims are backed by the [release notes](https://github.com/RiDDiX/home-assistant-matter-hub/releases) and the [supported device types](../supported-device-types.md) list. Upstream status is visible on the [archived repository](https://github.com/t0bst4r/home-assistant-matter-hub).
