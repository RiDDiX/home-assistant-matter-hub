import type React from "react";
import { useEffect, useState } from "react";
import {
  fetchEntityList,
  type HomeAssistantEntity,
} from "../../api/home-assistant-entities";
import {
  createStandaloneDevice,
  getStandaloneDevices,
} from "../../api/standalone-devices.ts";

// Supported device types for standalone devices
const SUPPORTED_DEVICE_TYPES = [
  { value: "light", label: "Light (On/Off, Dimmable, Color)" },
  { value: "switch", label: "Switch / Plug" },
  { value: "thermostat", label: "Thermostat" },
  { value: "temperature-sensor", label: "Temperature Sensor" },
  { value: "humidity-sensor", label: "Humidity Sensor" },
  { value: "cover", label: "Cover (Window, Garage, Gate)" },
  { value: "lock", label: "Lock" },
  { value: "fan", label: "Fan" },
  { value: "air-purifier", label: "Air Purifier" },
  { value: "valve", label: "Valve" },
  { value: "water-heater", label: "Water Heater" },
  { value: "media-player", label: "Media Player (Speaker, TV)" },
  { value: "siren", label: "Siren" },
  { value: "scene", label: "Scene" },
  { value: "input-button", label: "Input Button" },
  { value: "binary-sensor", label: "Binary Sensor (Contact, Motion, etc.)" },
  { value: "robot-vacuum", label: "Robot Vacuum" },
  { value: "select", label: "Select / Input Select" },
];

function StandaloneDevicesPage() {
  const [devices, setDevices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getStandaloneDevices()
      .then((devices) => setDevices(devices as any[]))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1>Standalone Devices</h1>
      {loading && <p>Loading...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}
      <ul>
        {devices.map((device: any) => (
          <li key={device.id}>
            <strong>{device.name}</strong> (Type: {device.deviceType})
          </li>
        ))}
      </ul>
      <hr />
      <h2>Add Standalone Device</h2>
      <DeviceCreationForm
        onCreated={(device) => setDevices([...devices, device])}
      />
    </div>
  );
}

export default StandaloneDevicesPage;
export { DeviceCreationForm };

function DeviceCreationForm({
  onCreated,
  initialValues,
}: {
  onCreated: (device: any) => void;
  initialValues?: Partial<{
    name: string;
    port: number;
    deviceType: string;
    entities: string[];
  }>;
}) {
  const [name, setName] = useState(initialValues?.name ?? "");
  const [port, setPort] = useState(initialValues?.port ?? 3000);
  const [deviceType, setDeviceType] = useState(initialValues?.deviceType ?? "");
  const [entities, setEntities] = useState<string[]>(
    initialValues?.entities ?? [],
  );
  const [entityInput, setEntityInput] = useState("");
  const [entitySuggestions, setEntitySuggestions] = useState<
    HomeAssistantEntity[]
  >([]);
  const [entityLoading, setEntityLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[] | null>(
    null,
  );
  const [success, setSuccess] = useState<string | null>(null);

  // Input validation helpers
  const isValidPort = (p: number) => p >= 1024 && p <= 65535;
  const isValidEntityId = (id: string) =>
    /^([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)$/.test(id);
  const invalidEntities = entities.filter((id) => !isValidEntityId(id));

  // Auto-complete entity suggestions
  useEffect(() => {
    if (!entityInput) {
      setEntitySuggestions([]);
      return;
    }
    setEntityLoading(true);
    fetchEntityList({ search: entityInput, limit: 10 })
      .then((list) => setEntitySuggestions(list))
      .catch(() => setEntitySuggestions([]))
      .finally(() => setEntityLoading(false));
  }, [entityInput]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Only clear error/success/validation if validation passes
    // Frontend validation
    if (!name.trim()) {
      setError("Device name is required.");
      // eslint-disable-next-line no-console
      console.log("Validation: Device name is required", { name, error });
      return;
    }
    if (!isValidPort(port)) {
      setError("Port must be between 1024 and 65535.");
      return;
    }
    if (!deviceType) {
      setError("Device type is required.");
      return;
    }
    if (entities.length === 0) {
      setError("At least one entity is required.");
      return;
    }
    if (invalidEntities.length > 0) {
      setError(`Invalid entity ID(s): ${invalidEntities.join(", ")}`);
      return;
    }
    setError(null);
    setValidationErrors(null);
    setSuccess(null);
    setLoading(true);
    try {
      const data = {
        name: name.trim(),
        port,
        filter: {}, // Placeholder, should be set as needed
        deviceType,
        entities,
      };
      const created = await createStandaloneDevice(data);
      onCreated(created);
      setName("");
      setPort(3000);
      setDeviceType("");
      setEntities([]);
      setEntityInput("");
      setSuccess("Device created successfully.");
    } catch (e: any) {
      if (e && e.error && e.validationErrors) {
        setError(e.error);
        setValidationErrors(e.validationErrors);
      } else {
        setError(e.message || "Failed to create device");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{ marginTop: 16, marginBottom: 32, maxWidth: 500 }}
    >
      <div style={{ marginBottom: 8 }}>
        <label title="A friendly name for this device (e.g. 'Living Room Lamp')">
          Name:
          <input
            value={name}
            onChange={(e) =>
              setName(e.target.value)
            } /* required removed for test JS validation */
            style={{
              marginLeft: 8,
              width: 220,
              borderColor: !name.trim() && error ? "red" : undefined,
            }}
            maxLength={64}
          />
        </label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label title="TCP port for this device (1024-65535)">
          Port:
          <input
            type="number"
            value={port}
            min={1024}
            max={65535}
            onChange={(e) => setPort(Number(e.target.value))}
            required
            style={{
              marginLeft: 8,
              width: 120,
              borderColor: !isValidPort(port) && error ? "red" : undefined,
            }}
          />
        </label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label title="The type of Matter device to create (e.g. Light, Lock, Fan)">
          Device Type:
          <select
            value={deviceType}
            onChange={(e) => setDeviceType(e.target.value)}
            required
            style={{
              marginLeft: 8,
              width: 260,
              borderColor: !deviceType && error ? "red" : undefined,
            }}
          >
            <option value="">Select type...</option>
            {SUPPORTED_DEVICE_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label title="Add Home Assistant entity IDs (auto-complete, e.g. 'light.living_room')">
          Entities:
          <div
            style={{ display: "flex", flexDirection: "column", marginLeft: 8 }}
          >
            <input
              value={entityInput}
              onChange={(e) => setEntityInput(e.target.value)}
              placeholder="Type to search entities..."
              style={{
                width: 300,
                borderColor: entities.length === 0 && error ? "red" : undefined,
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && entityInput.trim()) {
                  e.preventDefault();
                  if (
                    isValidEntityId(entityInput.trim()) &&
                    !entities.includes(entityInput.trim())
                  ) {
                    setEntities([...entities, entityInput.trim()]);
                    setEntityInput("");
                  }
                }
              }}
              list="entity-suggestions"
              autoComplete="off"
            />
            <datalist id="entity-suggestions">
              {entitySuggestions.map((ent) => (
                <option key={ent.entity_id} value={ent.entity_id}>
                  {ent.friendly_name || ent.entity_id}
                </option>
              ))}
            </datalist>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
              Example: <code>light.living_room</code>
              {entityLoading && (
                <span style={{ marginLeft: 8 }}>Loading...</span>
              )}
            </div>
            <div style={{ marginTop: 4 }}>
              {entities.map((id: string) => (
                <span
                  key={id}
                  style={{
                    display: "inline-block",
                    background: invalidEntities.includes(id)
                      ? "#ffdddd"
                      : "#e0e0e0",
                    color: invalidEntities.includes(id) ? "red" : "#333",
                    borderRadius: 12,
                    padding: "2px 10px",
                    marginRight: 6,
                    marginBottom: 2,
                    fontSize: 13,
                    border: invalidEntities.includes(id)
                      ? "1px solid red"
                      : "none",
                    cursor: "pointer",
                  }}
                  title={
                    invalidEntities.includes(id)
                      ? "Invalid entity ID"
                      : "Click to remove"
                  }
                  onClick={() =>
                    setEntities(entities.filter((eid: string) => eid !== id))
                  }
                >
                  {id} ×
                </span>
              ))}
            </div>
          </div>
        </label>
      </div>
      <button type="submit" disabled={loading} style={{ marginTop: 8 }}>
        {loading ? "Creating..." : "Create Device"}
      </button>
      {success && <div style={{ color: "green", marginTop: 8 }}>{success}</div>}
      {error && (
        <div
          style={{ color: "red", marginTop: 8 }}
          data-testid="device-form-error"
        >
          {error}
        </div>
      )}
      {validationErrors && validationErrors.length > 0 && (
        <div style={{ color: "darkorange", marginTop: 8 }}>
          <strong>Missing mandatory clusters:</strong>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {validationErrors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
