import qrcode from "qrcode-terminal";
import { pickPreferredUrl } from "./access-url.js";

const TERMINAL_QR_ERROR_LEVEL = "M";
const ANSI_BOLD = "\u001b[1m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_RESET = "\u001b[0m";
const OSC = "\u001b]";
const BEL = "\u0007";

function removeControlCharacters(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "");
}

export function pickScanUrl(urls) {
  return pickPreferredUrl(urls);
}

export function renderTerminalLink(url, label = url) {
  const href = removeControlCharacters(url).trim();
  const text = removeControlCharacters(label).trim() || href;

  if (!href) {
    return text;
  }

  return `${OSC}8;;${href}${BEL}${text}${OSC}8;;${BEL}`;
}

function pickLocalUrl(urls) {
  if (!Array.isArray(urls)) {
    return null;
  }

  return (
    urls.find((entry) => entry?.label === "Local") ??
    urls.find((entry) => {
      try {
        const url = new URL(entry?.url);
        return url.hostname === "localhost" || url.hostname === "127.0.0.1";
      } catch {
        return false;
      }
    }) ??
    null
  );
}

function pushUniqueLinkLine(lines, label, entry, seenUrls) {
  const url = String(entry?.url || "").trim();
  if (!url || seenUrls.has(url)) {
    return;
  }

  seenUrls.add(url);
  lines.push(`  ${label}: ${renderTerminalLink(url)}`);
}

export function renderOpenAppBanner(urls) {
  const primaryUrl = pickPreferredUrl(urls);
  if (!primaryUrl?.url) {
    return "";
  }

  const localUrl = pickLocalUrl(urls);
  const scanUrl = pickScanUrl(urls);
  const seenUrls = new Set();
  const lines = [
    `${ANSI_BOLD}${ANSI_CYAN}============================================================${ANSI_RESET}`,
    `${ANSI_BOLD}  OPEN VIBE RESEARCH${ANSI_RESET}`,
    `  Click this link: ${renderTerminalLink(primaryUrl.url)}`,
  ];

  seenUrls.add(String(primaryUrl.url));
  pushUniqueLinkLine(lines, "This laptop", localUrl, seenUrls);
  pushUniqueLinkLine(lines, "Phone / another device", scanUrl, seenUrls);
  lines.push(`${ANSI_BOLD}${ANSI_CYAN}============================================================${ANSI_RESET}`);

  return lines.join("\n");
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
  const lines = ["", "Vibe Research is live.", `Workspace: ${config.cwd}`, "Available URLs:"];

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
  lines.push("Get started:");
  lines.push("1. Open the clickable URL above. From another device, use a LAN/Tailscale URL or scan the QR code.");
  lines.push("2. Choose Claude Code in the agent selector if it is not already selected.");
  lines.push(
    `3. Tap New Agent. Vibe Research starts it in the default agent folder${config.defaultSessionCwd ? `: ${config.defaultSessionCwd}` : ""}.`,
  );
  lines.push("4. If Claude asks you to sign in, follow the prompt in that session.");
  lines.push("Remote access is optional: if Tailscale is already connected, its URL appears automatically.");

  lines.push("");
  lines.push("Providers:");
  for (const provider of config.providers) {
    lines.push(`- ${provider.label}: ${provider.available ? "available" : "missing"}`);
  }

  lines.push("Port access:");
  lines.push("- all-interface ports open directly at http://<host-ip>:<port>/ when reachable");
  lines.push("- Tailscale URLs and Serve actions appear when Tailscale is connected");
  lines.push("- proxy fallback: /proxy/<port>/");
  lines.push("Agent browser skill:");
  lines.push("- export PWCLI=\"${PWCLI:-vr-playwright}\"");
  lines.push("- \"$PWCLI\" open http://127.0.0.1:4173");
  lines.push("- \"$PWCLI\" snapshot");
  lines.push("- interact with fresh refs: \"$PWCLI\" click e3, fill e5, type text, press Enter");
  lines.push("- \"$PWCLI\" screenshot --filename output/playwright/current.png");
  lines.push(
    "- visual fallback: vr-browser describe-file results/chart.png --prompt \"What does this output show and what should improve?\"",
  );
  lines.push("");
  lines.push(`${ANSI_GREEN}running${ANSI_RESET}`);

  const openAppBanner = renderOpenAppBanner(config.urls);
  if (openAppBanner) {
    lines.push("");
    lines.push(openAppBanner);
  }

  return lines.join("\n");
}
