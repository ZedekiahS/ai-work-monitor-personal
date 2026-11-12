const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("quotaDesktop", {
  widget: (action, value) => ipcRenderer.invoke("aiwm-widget", action, value),
  quota: (action) => ipcRenderer.invoke("aiqw-quota", action),
});
