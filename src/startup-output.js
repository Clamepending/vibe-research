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

  if (config.stateDir) {
    lines.splice(3, 0, `State: ${config.stateDir}`);
  }

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

  lines.push("Port access:");
  lines.push("- all-interface ports open directly at http://<tailscale-ip>:<port>/");
  lines.push("- localhost-only ports can be exposed with Tailscale Serve from the ports panel");
  lines.push("- proxy fallback: /proxy/<port>/");
  lines.push("Agent browser skill:");
  lines.push("- export PWCLI=\"${PWCLI:-rv-playwright}\"");
  lines.push("- \"$PWCLI\" open http://127.0.0.1:4173");
  lines.push("- \"$PWCLI\" snapshot");
  lines.push("- interact with fresh refs: \"$PWCLI\" click e3, fill e5, type text, press Enter");
  lines.push("- \"$PWCLI\" screenshot --filename output/playwright/current.png");
  lines.push(
    "- visual fallback: rv-browser describe-file results/chart.png --prompt \"What does this output show and what should improve?\"",
  );
  lines.push("");
  lines.push(`${ANSI_GREEN}running${ANSI_RESET}`);

  return lines.join("\n");
}
