const title = document.querySelector("#title");
const detail = document.querySelector("#detail");
const phase = document.querySelector("#phase");
const log = document.querySelector("#log");
const retry = document.querySelector("#retry");
const openBrowser = document.querySelector("#open-browser");
const quit = document.querySelector("#quit");
const progressBar = document.querySelector("#progress-bar");

const progressByPhase = {
  checking: "18%",
  installing: "46%",
  starting: "74%",
  loading: "92%",
  failed: "100%",
};

function renderStatus(payload = {}) {
  const currentPhase = payload.phase || "checking";
  document.body.dataset.phase = currentPhase;
  title.textContent = payload.title || "Starting Vibe Research";
  detail.textContent = payload.detail || "Preparing the local desktop app.";
  phase.textContent = currentPhase;
  progressBar.style.width = progressByPhase[currentPhase] || "34%";
  retry.hidden = currentPhase !== "failed";

  if (Array.isArray(payload.logLines)) {
    log.textContent = payload.logLines.join("\n");
    log.scrollTop = log.scrollHeight;
  }
}

retry.addEventListener("click", () => {
  retry.hidden = true;
  window.vibeDesktop.retry();
});

openBrowser.addEventListener("click", () => {
  window.vibeDesktop.openBrowser();
});

quit.addEventListener("click", () => {
  window.vibeDesktop.quit();
});

window.vibeDesktop.onStatus(renderStatus);
renderStatus();
