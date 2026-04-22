const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibeDesktop", {
  onStatus(callback) {
    ipcRenderer.on("vibe-status", (_event, payload) => callback(payload));
  },
  retry() {
    return ipcRenderer.invoke("vibe-retry");
  },
  openBrowser() {
    return ipcRenderer.invoke("vibe-open-browser");
  },
  quit() {
    return ipcRenderer.invoke("vibe-quit");
  },
});
