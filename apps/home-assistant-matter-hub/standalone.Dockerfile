ARG NODE_VERSION="22"

FROM node:${NODE_VERSION}-alpine
RUN apk add --no-cache netcat-openbsd tini

ARG PACKAGE_VERSION="unknown"
ENV HAMH_STORAGE_LOCATION="/data"
ENV APP_VERSION="${PACKAGE_VERSION}"
VOLUME /data

LABEL package.version="$PACKAGE_VERSION"

RUN mkdir /install
COPY package.tgz /install/package.tgz
RUN npm install -g /install/package.tgz
RUN rm -rf /install

CMD exec home-assistant-matter-hub start
