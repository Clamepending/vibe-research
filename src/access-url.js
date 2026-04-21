export function looksLikeTailscaleUrl(entry) {
  if (!entry?.url) {
    return false;
  }

  const label = String(entry.label || "").toLowerCase();
  if (label.includes("tailscale")) {
    return true;
  }

  try {
    const { hostname } = new URL(entry.url);
    return hostname.endsWith(".ts.net") || (hostname.startsWith("100.") && /^u?tun\d*$/i.test(label));
  } catch {
    return false;
  }
}

function normalizeTailscaleDnsName(value) {
  return String(value || "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

export function getTailscaleDnsNameFromStatus(payload) {
  const dnsName = normalizeTailscaleDnsName(payload?.Self?.DNSName);
  return dnsName.endsWith(".ts.net") ? dnsName : "";
}

export function getTailscaleUrl(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return null;
  }

  return urls.find((entry) => looksLikeTailscaleUrl(entry))?.url ?? null;
}

function rootHandlerMentionsPort(handler, port) {
  const portPattern = new RegExp(`(^|[^0-9])${port}([^0-9]|$)`);
  return portPattern.test(JSON.stringify(handler ?? ""));
}

export function getTailscaleHttpsUrlFromServeStatus(payload, port, dnsName = "") {
  const normalizedPort = Number(port);
  const normalizedDnsName = normalizeTailscaleDnsName(dnsName);
  const web = payload?.Web && typeof payload.Web === "object" ? payload.Web : {};
  const entries = Object.entries(web);

  for (const [hostPort, config] of entries) {
    const [host = "", portText = ""] = String(hostPort).split(":");
    const normalizedHost = normalizeTailscaleDnsName(host);
    if (portText !== "443" || !normalizedHost.endsWith(".ts.net")) {
      continue;
    }

    if (normalizedDnsName && normalizedHost !== normalizedDnsName) {
      continue;
    }

    const rootHandler = config?.Handlers?.["/"];
    if (rootHandlerMentionsPort(rootHandler, normalizedPort)) {
      return `https://${normalizedHost}/`;
    }
  }

  if (normalizedDnsName) {
    return "";
  }

  for (const [hostPort, config] of entries) {
    const [host = "", portText = ""] = String(hostPort).split(":");
    const normalizedHost = normalizeTailscaleDnsName(host);
    if (
      portText === "443" &&
      normalizedHost.endsWith(".ts.net") &&
      rootHandlerMentionsPort(config?.Handlers?.["/"], normalizedPort)
    ) {
      return `https://${normalizedHost}/`;
    }
  }

  return "";
}

export function hasTailscaleHttpsRootServe(payload, dnsName = "") {
  const normalizedDnsName = normalizeTailscaleDnsName(dnsName);
  const web = payload?.Web && typeof payload.Web === "object" ? payload.Web : {};

  return Object.entries(web).some(([hostPort, config]) => {
    const [host = "", portText = ""] = String(hostPort).split(":");
    const normalizedHost = normalizeTailscaleDnsName(host);
    return (
      portText === "443" &&
      normalizedHost.endsWith(".ts.net") &&
      (!normalizedDnsName || normalizedHost === normalizedDnsName) &&
      Boolean(config?.Handlers?.["/"])
    );
  });
}

export function buildPortUrlFromBase(baseUrl, port) {
  if (!baseUrl) {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    url.protocol = "http:";
    url.port = String(port);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function pickPreferredUrl(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return null;
  }

  return (
    urls.find((entry) => {
      try {
        const url = new URL(entry?.url);
        return url.protocol === "https:" && url.hostname.endsWith(".ts.net");
      } catch {
        return false;
      }
    }) ??
    urls.find((entry) => looksLikeTailscaleUrl(entry)) ??
    urls.find((entry) => entry.label !== "Local") ??
    urls[0] ??
    null
  );
}
