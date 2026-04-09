import qrcode from "qrcode-terminal";
import { pickPreferredUrl } from "./access-url.js";

const TERMINAL_QR_ERROR_LEVEL = "M";
const ANSI_GREEN = "\u001b[32m";
const ANSI_RESET = "\u001b[0m";

export function pickScanUrl(urls) {
  return pickPreferredUrl(urls);
}

export function renderQrCode(url) {
  if (!url) {
    return "";
  }

  let output = "";
  qrcode.setErrorLevel(TERMINAL_QR_ERROR_LEVEL);
  qrcode.generate(url, { small: false }, (rendered) => {
    output = rendered.trimEnd();
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
  lines.push(`${ANSI_GREEN}running${ANSI_RESET}`);

  return lines.join("\n");
}
