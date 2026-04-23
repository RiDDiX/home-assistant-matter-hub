# Standalone Device Configuration

Standalone devices allow you to create Matter devices that are not part of a bridge. These devices are managed individually and can be exposed directly to controllers.

## Creating a Standalone Device

1. Open the web UI and go to the **Standalone Devices** page.
2. Click **Add Standalone Device**.
3. Fill out the form:
   - **Name**: A friendly name for your device (e.g., "Living Room Lamp").
   - **Port**: The TCP port for this device (1024-65535).
   - **Device Type**: Select the Matter device type (e.g., Light, Lock, Fan).
   - **Entities**: Add one or more Home Assistant entity IDs. Use the auto-complete to search and select entities. Invalid IDs are highlighted.
4. Click **Create Device**. Validation errors will be shown inline if any fields are invalid or required clusters are missing.

## Managing Standalone Devices

- **List**: All standalone devices are listed on the page.
- **Edit/Delete**: (If supported) You can edit or delete devices from the list.
- **Validation**: The system validates device type, port, and entity IDs. Missing mandatory clusters are reported.

## Use Cases
- Expose a single device (e.g., a lock or thermostat) directly to Matter controllers.
- Use for devices that should not be grouped in a bridge.

## Tips
- Use the auto-complete to avoid typos in entity IDs.
- Ensure the port does not conflict with other bridges or standalone devices.
- Device type selection determines the available clusters and features.

---

For more details on supported device types, see [Supported Device Types](../supported-device-types.md).

For advanced mapping and validation, see the [Developer Documentation](../developer/endpoints.md).
