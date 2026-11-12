const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("aiwmDesktop", {
  widget: (action, value) => ipcRenderer.invoke("aiwm-widget", action, value),
  onWidgetError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("aiwm-widget-error", listener);
    return () => ipcRenderer.removeListener("aiwm-widget-error", listener);
  },
});
