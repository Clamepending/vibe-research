import qrcode from "qrcode-terminal";

const TERMINAL_QR_SCALE = 2;

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

function scaleQrCode(text, scale = TERMINAL_QR_SCALE) {
  if (!text || scale <= 1) {
    return text;
  }

  return text
    .split("\n")
    .flatMap((line) => {
      const expanded = Array.from(line, (char) => char.repeat(scale)).join("");
      return Array(scale).fill(expanded);
    })
    .join("\n");
}

export function renderQrCode(url) {
  if (!url) {
    return "";
  }

  let output = "";
  qrcode.generate(url, { small: true }, (rendered) => {
    output = scaleQrCode(rendered.trimEnd());
  });
  return output;
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
