const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("appApi", {
  pickFile: (payload) => ipcRenderer.invoke("dialog:pickFile", payload),
  readBinaryFile: (filePath) => ipcRenderer.invoke("file:readBinary", filePath),
  savePng: (payload) => ipcRenderer.invoke("file:savePng", payload),
  saveState: (state) => ipcRenderer.invoke("state:save", state),
  loadState: () => ipcRenderer.invoke("state:load"),
  getDefaultAssets: () => ipcRenderer.invoke("app:getDefaultAssets"),
  reloadCode: () => ipcRenderer.invoke("app:reloadCode")
});
