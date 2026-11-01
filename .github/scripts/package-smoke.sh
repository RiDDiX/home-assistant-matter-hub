#!/usr/bin/env bash
# Install the packed tarball like the Docker images do and check that it boots.
set -euo pipefail
tgz=$(realpath "$1")
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cd "$dir"
# Same wrapper as the Dockerfiles, so the package overrides apply.
tar -xzOf "$tgz" package/package.json | node -e '
  const pkg = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const dependencies = { "home-assistant-matter-hub": "file:" + process.argv[1] };
  console.log(JSON.stringify({ private: true, dependencies, overrides: pkg.overrides }));
' "$tgz" >package.json
npm install --omit=dev --no-audit --no-fund >/dev/null
bin=node_modules/.bin/home-assistant-matter-hub
"$bin" --help >/dev/null
# silly is an add-on log level matter.js does not know, it crashed the
# bundle while bootstrap.js was external. HA is unreachable on purpose, the
# client keeps retrying, so a good build is still running when the timeout hits.
rc=0
timeout -k 10 20 "$bin" start --home-assistant-url=http://127.0.0.1:1 \
  --home-assistant-access-token=smoke --storage-location="$dir/data" \
  --log-level=silly >start.log 2>&1 || rc=$?
if [ "$rc" != 124 ]; then
  echo "start exited early ($rc)"
  tail -n 30 start.log
  exit 1
fi
