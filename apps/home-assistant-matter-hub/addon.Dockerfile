ARG NODE_VERSION="24"

FROM node:${NODE_VERSION}-alpine AS nodebuild

FROM ghcr.io/hassio-addons/base:18.2.1

# Install Node.js
RUN apk add --no-cache libstdc++ bash
COPY --from=nodebuild /usr/local/bin/node /usr/local/bin/
COPY --from=nodebuild /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack
RUN corepack enable

ENV SUPERVISOR_TOKEN=""
VOLUME /config

COPY addon.docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ARG PACKAGE_VERSION="unknown"
ENV APP_VERSION="${PACKAGE_VERSION}"
LABEL \
  io.hass.version="$PACKAGE_VERSION" \
  io.hass.type="addon" \
  io.hass.arch="aarch64|amd64"

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

CMD ["/docker-entrypoint.sh"]
