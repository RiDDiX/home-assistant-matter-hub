# Running on Low-Resource Devices

This guide covers setup recommendations for Raspberry Pi (especially 2-4 GB models), Home Assistant Yellow, and VMs with limited RAM.

## Memory Requirements

HAMH loads Matter.js cluster definitions, the Home Assistant entity registry, and V8 runtime overhead at startup. Typical memory usage:

| Phase | Estimated Usage |
|---|---|
| Node.js + Matter.js cluster definitions | 200-300 MB |
| Home Assistant registry (entities, devices, states) | 50-150 MB (scales with entity count) |
| Per Matter endpoint | 1-3 MB each |
| **Typical steady state (moderate install)** | **400-600 MB** |

### Dynamic Heap Sizing

Since v2.0.25, HAMH automatically sizes the Node.js heap to **25% of available system memory**, clamped between 256 MB and 1024 MB. The calculated value is logged at startup:

```
Memory: total=4096MB, available=3200MB, cgroup=noneMB -> heap: 800MB
```

On a 2 GB system this gives ~512 MB of heap, tight for large bridge configurations.

## Recommended Configuration by RAM

### 2 GB (Raspberry Pi 4 2GB, small VMs)

- Limit bridges to **1-2 bridges** with **50 or fewer entities total**
- Disable `autoComposedDevices` unless needed
- Stop other memory-heavy add-ons (see below)
- Enable swap (see [Swap Configuration](#swap-configuration))

### 4 GB (Raspberry Pi 4/5 4GB, HA Yellow)

- Works well with **2-4 bridges** and **100-200 entities**
- Monitor the startup log for "Memory pressure detected" warnings
- Swap recommended but not required

### 8 GB+

- No special configuration needed

## Reducing Memory Usage

### 1. Reduce entities per bridge

Each Matter endpoint uses 1-3 MB of memory. Fewer entities = less memory. Split large bridges into smaller ones (e.g. per room or per domain).

### 2. Stop memory-heavy add-ons

These add-ons can consume significant RAM alongside HAMH:

- **Frigate** (video processing)
- **Whisper** (speech-to-text)
- **Piper** (text-to-speech)
- **Music Assistant**
- **Python Matter Server** (not needed when using HAMH)

### 3. Override the heap size

If the automatic 25% calculation is too low or too high, override it:

**Home Assistant Add-on:** Not directly configurable, the entrypoint script sets it automatically.

**Standalone Docker:**

```bash
docker run -e NODE_OPTIONS="--max-old-space-size=768" ghcr.io/riddix/home-assistant-matter-hub
```

**npm (direct install):**

```bash
NODE_OPTIONS="--max-old-space-size=768" home-assistant-matter-hub start
```

## Swap Configuration

On systems with 2-4 GB RAM, enabling swap provides a safety net against OOM kills. Swap is slower than RAM but prevents the Linux kernel from terminating the process.

### Checking current swap

```bash
free -h
```

### Adding swap on Raspberry Pi OS

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

### Adding swap on Home Assistant OS

Home Assistant OS manages swap automatically. If you are running out of memory, increasing RAM (via hardware upgrade or VM settings) is the recommended path.

## Diagnosing OOM Kills

### Symptoms

- The add-on/container restarts without any error message or stack trace
- Logs show `Killed` as the last line
- `docker inspect` shows `OOMKilled: true` or exit code `137`

### Checking for OOM events

```bash
# Check container status
docker inspect <container> | grep -A5 '"State"'

# Check kernel logs for OOM events
dmesg | grep -i "oom\|killed"
journalctl -k | grep -i "oom\|killed"
```

### Startup memory guard

HAMH logs system memory information at startup. If free memory is below 512 MB, a warning is shown:

```
WARN: Low memory detected (384 MB free). HAMH typically needs 400-600 MB.
Consider reducing the number of entities per bridge, stopping memory-heavy
add-ons, or increasing available RAM.
```

## Monitoring Memory Usage

### From the host

```bash
# Live container memory usage
docker stats <container>

# Peak memory since last restart
docker inspect <container> --format='{{.HostConfig.Memory}}'
```

### From HAMH logs

HAMH logs heap usage at debug level during key operations. Set the log level to `debug` temporarily to see these entries:

```
Memory [after HA registry load]: heap 180/256 MB, rss 320 MB
```

If heap usage is consistently above 80% of the limit, consider reducing entities or increasing the heap size.
