function looksLikeTailscaleUrl(entry) {
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
