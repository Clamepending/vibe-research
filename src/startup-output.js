import qrcode from "qrcode-terminal";

export function pickScanUrl(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return null;
  }

  return (
    urls.find((entry) => entry.label === "Tailscale") ??
    urls.find((entry) => entry.label !== "Local") ??
    urls[0] ??
    null
  );
}

export function renderQrCode(url) {
  if (!url) {
    return "";
  }

  let output = "";
  qrcode.generate(url, { small: true }, (rendered) => {
    output = rendered;
  });
  return output.trimEnd();
}

export function buildStartupOutput(config) {
  const lines = ["", "Remote Vibes is live.", `Workspace: ${config.cwd}`, "Available URLs:"];

  for (const entry of config.urls) {
    lines.push(`- ${entry.label}: ${entry.url}`);
  }

  const scanUrl = pickScanUrl(config.urls);
  const qrCode = renderQrCode(scanUrl?.url);
  if (scanUrl && qrCode) {
    lines.push("");
    lines.push(`Scan on phone: ${scanUrl.url}`);
    lines.push(qrCode);
  }

  lines.push("");
  lines.push("Providers:");
  for (const provider of config.providers) {
    lines.push(`- ${provider.label}: ${provider.available ? "available" : "missing"}`);
  }

  lines.push("Port proxy:");
  lines.push("- /proxy/<port>/");
  lines.push("");

  return lines.join("\n");
}
