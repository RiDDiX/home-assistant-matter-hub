ARG NODE_VERSION="24"

FROM node:${NODE_VERSION}-alpine
RUN apk add --no-cache netcat-openbsd tini

ARG PACKAGE_VERSION="unknown"
ENV HAMH_STORAGE_LOCATION="/data"
ENV APP_VERSION="${PACKAGE_VERSION}"
VOLUME /data

LABEL package.version="$PACKAGE_VERSION"

RUN mkdir /install
COPY package.tgz /install/package.tgz
# Install the tarball inside a wrapper project so its "overrides" field
# actually applies during resolution. `npm install -g <tgz>` ignores
# transitive overrides, which leaves vulnerable minimatch/path-to-regexp
# copies in place. The wrapper project plus a symlinked bin avoids that.
RUN printf '%s\n' \
      '{' \
      '  "name": "hamh-wrapper",' \
      '  "version": "0.0.0",' \
      '  "private": true,' \
      '  "dependencies": {' \
      '    "home-assistant-matter-hub": "file:/install/package.tgz"' \
      '  },' \
      '  "overrides": {' \
      '    "minimatch": "9.0.7",' \
      '    "path-to-regexp": "^8.4.0",' \
      '    "glob": "^13.0.0"' \
      '  }' \
      '}' > /install/package.json \
 && cd /install \
 && npm install --omit=dev --no-audit --no-fund \
 && ln -s /install/node_modules/.bin/home-assistant-matter-hub /usr/local/bin/home-assistant-matter-hub \
 && rm /install/package.tgz

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO /dev/null http://localhost:8482/api/health/live || exit 1

# Dynamic heap sizing: 25% of effective memory, clamped to 256-2048MB.
# Checks cgroup limits (Docker), then MemAvailable, then MemTotal.
# Override with: docker run -e NODE_OPTIONS="--max-old-space-size=2048" ...
CMD total_mem_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null); \
    avail_mem_mb=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null); \
    cgroup_limit_mb=""; \
    if [ -f /sys/fs/cgroup/memory.max ]; then \
      cgroup_raw=$(cat /sys/fs/cgroup/memory.max 2>/dev/null); \
      if [ "$cgroup_raw" != "max" ] && [ -n "$cgroup_raw" ]; then \
        cgroup_limit_mb=$((cgroup_raw / 1024 / 1024)); \
      fi; \
    elif [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then \
      cgroup_raw=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null); \
      if [ -n "$cgroup_raw" ] && [ "$cgroup_raw" -lt 9000000000000 ]; then \
        cgroup_limit_mb=$((cgroup_raw / 1024 / 1024)); \
      fi; \
    fi; \
    if [ -n "$cgroup_limit_mb" ] && [ "$cgroup_limit_mb" -gt 0 ]; then \
      effective_mem=$cgroup_limit_mb; \
    elif [ -n "$avail_mem_mb" ] && [ "$avail_mem_mb" -gt 0 ]; then \
      effective_mem=$avail_mem_mb; \
    else \
      effective_mem=${total_mem_mb:-0}; \
    fi; \
    if [ "$effective_mem" -eq 0 ]; then heap_size=256; \
    else heap_size=$((effective_mem / 4)); \
      [ "$heap_size" -lt 256 ] && heap_size=256; \
      [ "$heap_size" -gt 2048 ] && heap_size=2048; \
    fi; \
    echo "Memory: total=${total_mem_mb:-?}MB, available=${avail_mem_mb:-?}MB, cgroup=${cgroup_limit_mb:-none}MB -> heap: ${heap_size}MB"; \
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=${heap_size}}"; \
    exec home-assistant-matter-hub start
