export function looksLikeTailscaleUrl(entry) {
  if (!entry?.url) {
    return false;
  }

  if (String(entry.label || "").toLowerCase().includes("tailscale")) {
    return true;
  }

  try {
    const { hostname } = new URL(entry.url);
    return hostname.startsWith("100.") || hostname.endsWith(".ts.net");
  } catch {
    return false;
  }
}

export function getTailscaleUrl(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return null;
  }

  return urls.find((entry) => looksLikeTailscaleUrl(entry))?.url ?? null;
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
    urls.find((entry) => looksLikeTailscaleUrl(entry)) ??
    urls.find((entry) => entry.label !== "Local") ??
    urls[0] ??
    null
  );
}
