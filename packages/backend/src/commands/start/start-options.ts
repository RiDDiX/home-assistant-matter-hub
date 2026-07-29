export interface StartOptions {
  "log-level": string;
  "protocol-log-level": string;
  "http-port": number;
  "http-ip-whitelist": (string | number)[] | undefined;
  "disable-log-colors": boolean;
  "json-logs": boolean;
  "storage-location": string | undefined;
  "mdns-disable-ipv4": boolean;
  "mdns-network-interface": string | undefined;
  "mdns-strip-global-ipv6": boolean;
  "home-assistant-url": string;
  "home-assistant-access-token": string;
  "home-assistant-refresh-interval": number;
  "ha-message-timeout": number;
  "http-auth-username": string | undefined;
  "http-auth-password": string | undefined;
  "http-base-path": string | undefined;
}
