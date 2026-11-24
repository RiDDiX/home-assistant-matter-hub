# Using a reverse proxy

Configure a HAMH web login before exposing a standalone instance through a reverse proxy. Set `HAMH_HTTP_AUTH_USERNAME` and `HAMH_HTTP_AUTH_PASSWORD`, or visit the app directly on localhost to set a login in Settings. Forward authentication headers for HTTP and WebSocket requests. Set `X-Forwarded-For` so HAMH can distinguish proxied requests from local setup when the proxy runs on the same machine.

## WebSocket Support

HAMH uses WebSocket connections for real-time bridge status updates and live diagnostics. Your reverse proxy **must** forward WebSocket upgrade requests, otherwise the UI will not receive live updates.

All nginx examples below include the required WebSocket headers.

## Running on its own domain

If you run the application on its own domain (e.g. `matter.example.org`), start HAMH with `--http-allowed-hosts=matter.example.org` (see below).
For `nginx` you could use a config as easy as this:

```nginx
location / {
    proxy_pass http://192.168.178.23:8482/;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## Host and Origin checks

To stop other websites from talking to HAMH through your browser, HAMH only answers requests whose `Host` is an IP address, `localhost`, a single-label name or a name ending in `.local`, `.localhost`, `.home.arpa`, `.lan`, `.internal` or `.fritz.box`. Any other public name your proxy passes as `Host` must be listed with `--http-allowed-hosts` (or `HAMH_HTTP_ALLOWED_HOSTS`).
Browser requests whose `Origin` differs from the `Host` are rejected, unless the `Origin` host is listed in `--http-allowed-hosts` or the request comes through Home Assistant ingress.
The Home Assistant add-on panel (ingress) needs no setting, whatever name Home Assistant is reached by.
So a proxy on `matter.example.org` needs `--http-allowed-hosts=matter.example.org`, whether or not it rewrites the `Host` header.

## Running in a sub-path

If you want to run the application in a sub-location, let your proxy remove the sub-path from the URL and send it in the `x-forwarded-prefix` header.
If your proxy cannot remove it, configure the sub-path in HAMH instead.

## Removing the sub-path from the URL

For nginx this looks like:

```nginx
location /hamh/ {
    # it is important to have a trailing slash,
    # otherwise nginx will not remove the "/hamh" prefix
    proxy_pass http://192.168.178.23:8482/;
    proxy_set_header x-forwarded-prefix /hamh;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

`x-ingress-path` is only there for compatibility with Home Assistant versions older than 2026.12. Use `x-forwarded-prefix` in your own proxy.

> **Note on trust:** HAMH uses the `x-forwarded-prefix` and `x-ingress-path` headers verbatim to rebuild URLs for the web UI. If the app is reachable directly (no reverse proxy in front), a client could set these headers themselves. Either run HAMH behind a trusted proxy that strips/overwrites them, or bind HAMH to a local interface only and expose it exclusively via the proxy.

## Keeping the sub-path in the URL

Start HAMH with `--http-base-path=/hamh` (or `HAMH_HTTP_BASE_PATH=/hamh`), and do not set `x-forwarded-prefix`.

For nginx this looks like:

```nginx
location /hamh/ {
    # the missing trailing slash will configure nginx to NOT remove the "/hamh" prefix
    proxy_pass http://192.168.178.23:8482;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

> **Deprecated:** Earlier versions of this guide set `x-forwarded-prefix` here instead. That still works, but HAMH logs a warning, and it may stop working in a future version. Either add the trailing slash to `proxy_pass` so nginx removes the sub-path, or remove the `x-forwarded-prefix` line and set `--http-base-path` at the same time.
