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
  if (!Number.isInteger(port)) {
    return false;
  }

  const portPattern = new RegExp(`(^|[^0-9])${port}([^0-9]|$)`);
  return portPattern.test(JSON.stringify(handler ?? ""));
}

function parseTailscaleWebHostPort(hostPort) {
  const value = String(hostPort || "");
  const bracketed = value.match(/^\[([^\]]+)]:(\d+)$/);
  if (bracketed) {
    return {
      host: normalizeTailscaleDnsName(bracketed[1]),
      port: Number(bracketed[2]),
    };
  }

  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex <= 0) {
    return {
      host: normalizeTailscaleDnsName(value),
      port: 443,
    };
  }

  return {
    host: normalizeTailscaleDnsName(value.slice(0, separatorIndex)),
    port: Number(value.slice(separatorIndex + 1)),
  };
}

function formatTailscaleHttpsUrl(host, httpsPort) {
  return `https://${host}${httpsPort && httpsPort !== 443 ? `:${httpsPort}` : ""}/`;
}

export function getTailscaleHttpsUrlFromServeStatus(payload, port, dnsName = "") {
  const normalizedPort = Number(port);
  const normalizedDnsName = normalizeTailscaleDnsName(dnsName);
  const web = payload?.Web && typeof payload.Web === "object" ? payload.Web : {};
  const entries = Object.entries(web)
    .map(([hostPort, config]) => ({
      ...parseTailscaleWebHostPort(hostPort),
      config,
    }))
    .filter((entry) => entry.host.endsWith(".ts.net") && Number.isInteger(entry.port));

  for (const { host, port: httpsPort, config } of entries) {
    if (normalizedDnsName && host !== normalizedDnsName) {
      continue;
    }

    const rootHandler = config?.Handlers?.["/"];
    if (rootHandlerMentionsPort(rootHandler, normalizedPort)) {
      return formatTailscaleHttpsUrl(host, httpsPort);
    }
  }

  if (normalizedDnsName) {
    return "";
  }

  for (const { host, port: httpsPort, config } of entries) {
    if (rootHandlerMentionsPort(config?.Handlers?.["/"], normalizedPort)) {
      return formatTailscaleHttpsUrl(host, httpsPort);
    }
  }

  return "";
}

export function hasTailscaleHttpsRootServe(payload, dnsName = "", httpsPort = null) {
  const normalizedDnsName = normalizeTailscaleDnsName(dnsName);
  const normalizedHttpsPort = httpsPort === null ? null : Number(httpsPort);
  const web = payload?.Web && typeof payload.Web === "object" ? payload.Web : {};

  return Object.entries(web).some(([hostPort, config]) => {
    const parsed = parseTailscaleWebHostPort(hostPort);
    if (!parsed.host.endsWith(".ts.net")) {
      return false;
    }

    if (normalizedDnsName && parsed.host !== normalizedDnsName) {
      return false;
    }

    if (
      normalizedHttpsPort !== null &&
      (!Number.isInteger(normalizedHttpsPort) || parsed.port !== normalizedHttpsPort)
    ) {
      return false;
    }

    return Boolean(config?.Handlers?.["/"]);
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
