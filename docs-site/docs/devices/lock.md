# Lock

Home Assistant `lock` entities are mapped to Matter **DoorLock** devices with PIN code support where available.

## Features

- **Lock**, Always allowed, no PIN required
- **Unlock**, Requires PIN if credentials are configured
- **Unlatch / Unbolt**, Available when the HA entity supports the `OPEN` feature. Unlatch (unlock) maps to `lock.open`, unbolt maps to `lock.unlock`. Apple Home shows an "Unlatch" button.

## State Mapping

| HA State | Matter Lock State |
|----------|------------------|
| `locked` / `locking` | Locked |
| `unlocked` / `unlocking` | Unlocked |
| `open` / `opening` | Unlatched |

## PIN Credentials

You can configure PIN codes through the **Entity Mapping** UI to require a code when unlocking from a Matter controller.

### Setup

1. Go to your Bridge in the Dashboard
2. Find your lock entity
3. Click **Edit Mapping**
4. In the **PIN Credentials** section, add one or more PIN codes
5. Save the mapping

When PIN credentials are configured, controllers will prompt for a code before unlocking. The PIN is validated by the bridge, only matching codes will trigger the `lock.unlock` action in HA.

### Lock without PIN

Locking is always allowed without a PIN. Only the unlock action requires PIN entry when credentials are configured.

### Apple Home access code prompt

After commissioning a lock with PIN support, Apple Home may show a one-time "Set Up an Access Code" prompt the first time you open the lock's details. Enter the same PIN you configured for this entity in HAMH so Apple Home and the bridge agree on the credential. If you do not want PIN prompts at all, set `disableLockPin` on the entity mapping; HAMH then advertises the lock without the PinCredential feature and Apple Home will skip the access code setup.

### Programming the physical lock (opt-in)

By default the PIN lives only in HAMH. It gates remote unlock at the bridge and is never written to the lock hardware.

If you want a code that a controller sets or clears to also land on the physical lock, set both `lockUsercodeService` and `lockUsercodeSlot` on the entity mapping. When they are set, a controller's `SetCredential` also programs that slot on the lock, and `ClearCredential` clears it.

| Service | PIN parameter | Slot parameter |
|---------|---------------|----------------|
| `zwave_js.set_lock_usercode` | `usercode` | `code_slot` |
| `zha.set_lock_user_code` | `user_code` | `code_slot` |

The clear call is derived from the set service (`zwave_js.clear_lock_usercode`, `zha.clear_lock_user_code`). The slot number is passed verbatim; it defaults to `1` when only the service is set. The service targets the lock entity, so no separate target is needed.

The passthrough is fire and forget: a failed physical program still reports success to the controller, so the credential stays usable for remote unlock. This is independent of `disableLockPin`.

## Unlatch (Unbolting)

Since v2.0.25, the Unbolting feature is automatically enabled when your HA lock entity supports the `OPEN` feature (reported in `supported_features`).

When enabled:
- Apple Home shows an "Unlatch" button alongside Lock/Unlock
- Unlatch (unlock) calls `lock.open`; unbolt (Google's "open door when unlocking" off) calls `lock.unlock`
- Useful for door openers, electric strikes, and motorized locks with separate unlatch capability

## Compatibility

| Controller | Lock | Unlock | PIN Entry | Unlatch |
|------------|------|--------|-----------|---------|
| Apple Home | ✅ | ✅ | ✅ | ✅ |
| Google Home | ✅ | ⚠️ | ⚠️ | ❌ |
| Amazon Alexa | ✅ | ✅ | ⚠️ | ❌ |

> **Google Home** has disabled voice unlock for Matter locks (Google policy). You can still unlock via the Google Home app.
>
> **PIN entry** support varies by controller. Apple Home has the best PIN code support.

## Troubleshooting

### Controller won't unlock the door

1. Check if you have PIN credentials configured, if so, ensure the controller supports PIN entry
2. Try unlocking via the controller app (not voice) to see if a PIN prompt appears
3. Google Home blocks voice unlock for Matter locks by policy

### Unlatch button not showing in Apple Home

1. Verify your HA lock entity supports the `OPEN` feature (check `supported_features` in Developer Tools → States)
2. Remove and re-add the device in Apple Home (device capabilities changed)
3. Ensure you're on v2.0.25 or later

### Lock state not updating

Check that your HA lock entity is updating its state correctly in Developer Tools. Some lock integrations have a delay between the physical lock state and the HA state update. The bridge reflects whatever state HA reports.
