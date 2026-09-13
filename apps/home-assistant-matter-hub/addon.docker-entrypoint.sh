#!/usr/bin/with-contenv bashio

# Dynamically limit Node.js heap based on available container memory.
# Docker containers may have cgroup memory limits that are lower than
# the host's total RAM. We check (in order):
#   1. cgroups v2 limit (/sys/fs/cgroup/memory.max), used by HA OS
#   2. cgroups v1 limit (/sys/fs/cgroup/memory/memory.limit_in_bytes)
#   3. MemAvailable from /proc/meminfo (actual free memory)
#   4. MemTotal from /proc/meminfo (fallback)
# Heap = 50% of effective memory, clamped to 256-2048MB. A quarter left large
# bridges short on machines that had the memory to spare.
# The heap_size_mb add-on option wins over the computed value, and a pre-set
# NODE_OPTIONS wins over both: node takes the LAST --max-old-space-size, so
# ours goes first.

total_mem_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
avail_mem_mb=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)

# Check cgroup memory limit (container limit may be lower than host RAM)
cgroup_limit_mb=""
if [ -f /sys/fs/cgroup/memory.max ]; then
  cgroup_raw=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
  if [ "$cgroup_raw" != "max" ] && [ -n "$cgroup_raw" ]; then
    cgroup_limit_mb=$((cgroup_raw / 1024 / 1024))
  fi
elif [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
  cgroup_raw=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
  # cgroups v1 uses a very large number (~2^63) to mean "no limit"
  if [ -n "$cgroup_raw" ] && [ "$cgroup_raw" -lt 9000000000000 ]; then
    cgroup_limit_mb=$((cgroup_raw / 1024 / 1024))
  fi
fi

# Use the most constrained value as the effective memory base
if [ -n "$cgroup_limit_mb" ] && [ "$cgroup_limit_mb" -gt 0 ]; then
  effective_mem=$cgroup_limit_mb
  mem_source="cgroup"
elif [ -n "$avail_mem_mb" ] && [ "$avail_mem_mb" -gt 0 ]; then
  effective_mem=$avail_mem_mb
  mem_source="available"
else
  effective_mem=${total_mem_mb:-0}
  mem_source="total"
fi

if [ "$effective_mem" -eq 0 ]; then
  heap_size=256
else
  heap_size=$((effective_mem / 2))
  [ "$heap_size" -lt 256 ] && heap_size=256
  [ "$heap_size" -gt 2048 ] && heap_size=2048
fi

# Explicit override for installs that need more than the machine suggests, for
# example a large bridge on a box with little free memory but plenty of swap.
heap_override=$(bashio::config 'heap_size_mb' '0')
case "$heap_override" in
  '' | *[!0-9]*) heap_override=0 ;;
  # More digits than any real machine has megabytes: node overflows such a
  # value into a tiny heap, so treat it as unset.
  ????????*) heap_override=0 ;;
esac
if [ "$heap_override" -gt 0 ]; then
  bashio::log.info "Memory: heap_size_mb option set, using ${heap_override}MB instead of the computed ${heap_size}MB"
  heap_size=$heap_override
else
  bashio::log.info "Memory: total=${total_mem_mb:-?}MB, available=${avail_mem_mb:-?}MB, cgroup=${cgroup_limit_mb:-none}MB → using ${mem_source} (${effective_mem}MB) → heap: ${heap_size}MB"
fi

case "${NODE_OPTIONS:-}" in
  *--max-old-space-size-percentage=* | *--max-old-space-size=*)
    bashio::log.info "Memory: NODE_OPTIONS already sets a heap size, that one wins"
    ;;
esac
export NODE_OPTIONS="--max-old-space-size=${heap_size}${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
export APP_VERSION="${APP_VERSION:-$(bashio::addon.version)}"

exec home-assistant-matter-hub start \
  --log-level=$(bashio::config 'app_log_level') \
  --disable-log-colors=$(bashio::config 'disable_log_colors') \
  --mdns-disable-ipv4=$(bashio::config 'mdns_disable_ipv4' 'false') \
  --mdns-network-interface="$(bashio::config 'mdns_network_interface')" \
  --mdns-strip-global-ipv6=$(bashio::config 'mdns_strip_global_ipv6' 'false') \
  --storage-location=/config/data \
  --web-port=$(bashio::addon.ingress_port) \
  --home-assistant-url='http://supervisor/core' \
  --home-assistant-access-token="$SUPERVISOR_TOKEN" \
  --http-ip-whitelist="172.30.32.2"
