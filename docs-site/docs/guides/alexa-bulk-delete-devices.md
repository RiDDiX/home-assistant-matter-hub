# Bulk Delete Alexa Smart Home Devices

If you have many old or duplicate smart home devices in Alexa, for example after migrating from HAASKA or after
reconfiguring your bridge, deleting them one by one through the Alexa app can be tedious. This guide describes a
faster method using the Amazon web interface and the browser developer console.

:::warning
This deletes **all** smart home devices from your Alexa account, not just those from Home Assistant Matter Hub.
After deletion, run "Alexa, discover devices" to re-add devices from your active skills and bridges.
:::

## Prerequisites

- A web browser (Chrome, Firefox, Edge, etc.)
- You must be logged in to your Amazon account

## Steps

### 1. Find your regional Alexa API endpoint

Open one of the following URLs in your browser and check which one returns a JSON list of your devices:

| Region | URL |
|--------|-----|
| Germany | `https://alexa.amazon.de/api/behaviors/entities?skillId=amzn1.ask.1p.smarthome` |
| US | `https://alexa.amazon.com/api/behaviors/entities?skillId=amzn1.ask.1p.smarthome` |
| US (alt) | `https://layla.amazon.com/api/behaviors/entities?skillId=amzn1.ask.1p.smarthome` |
| US (alt 2) | `https://pitangui.amazon.com/api/behaviors/entities?skillId=amzn1.ask.1p.smarthome` |
| Japan | `https://alexa.amazon.co.jp/api/behaviors/entities?skillId=amzn1.ask.1p.smarthome` |
| Spain | `https://alexa.amazon.es/api/behaviors/entities?skillId=amzn1.ask.1p.smarthome` |

You should see a JSON response containing your devices. If you get an error, try a different URL or make sure you are
logged in.

### 2. Open the developer console

On the same page where you got the JSON response, open the browser developer console:

- **Chrome / Edge**: Press `F12` or `Ctrl+Shift+J` (Windows/Linux) / `Cmd+Option+J` (macOS)
- **Firefox**: Press `F12` or `Ctrl+Shift+K` (Windows/Linux) / `Cmd+Option+K` (macOS)

### 3. Run the deletion script

Paste the following script into the console and press Enter:

```js
devices = await (await fetch('/nexus/v1/graphql', {
  method: 'POST',
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json"
  },
  body: JSON.stringify({
    query: `query {
      endpoints {
        items {
          friendlyName
          legacyAppliance { applianceId }
        }
      }
    }`
  })
})).json();

for (const device of devices.data.endpoints.items) {
  const res = await fetch(
    `/api/phoenix/appliance/${encodeURIComponent(device.legacyAppliance.applianceId)}`,
    {
      method: "DELETE",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    }
  );
  console.log(device.friendlyName, res.status);
}
```

The console will log each device name and the HTTP status code (`200` = success).

### 4. Refresh and rediscover

1. Refresh the page, the device list should now be empty.
   If devices still remain, you may have a CSRF issue; try logging out and back in, then repeat from step 1.
2. Say **"Alexa, discover devices"** to re-add devices from your active skills and Matter bridges.
3. Refresh the page again to confirm only your current devices are listed.

## Credits

This method was originally shared by [rPraml](https://gist.github.com/rPraml/0b685bfaeb3a29a437c4a1f2cc3e23de) and
brought to our attention by [backcountrymountains](https://github.com/RiDDiX/home-assistant-matter-hub/discussions/267).
