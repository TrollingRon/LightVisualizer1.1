const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

let mainWindow = null;

const STATE_FILE = () => path.join(app.getPath("userData"), "state.json");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: "#101217",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  mainWindow.webContents.on("console-message", (_, level, message, line, sourceId) => {
    const lvl = ["log", "warn", "error", "debug"][level] || String(level);
    // Surface renderer errors in terminal/build logs for fast diagnosis.
    // eslint-disable-next-line no-console
    console.log(`[renderer:${lvl}] ${sourceId}:${line} ${message}`);
  });

  mainWindow.webContents.on("render-process-gone", (_, details) => {
    // eslint-disable-next-line no-console
    console.error("[renderer:gone]", details);
  });
}

function extToMime(ext) {
  const low = ext.toLowerCase();
  if (low === ".png") return "image/png";
  if (low === ".jpg" || low === ".jpeg") return "image/jpeg";
  if (low === ".exr") return "application/octet-stream";
  return "application/octet-stream";
}

ipcMain.handle("dialog:pickFile", async (_, payload) => {
  const { title, filters } = payload;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title || "Select file",
    properties: ["openFile"],
    filters: filters || [{ name: "All Files", extensions: ["*"] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("file:readBinary", async (_, filePath) => {
  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath);
    return {
      ok: true,
      data: data.toString("base64"),
      ext,
      mime: extToMime(ext),
      name: path.basename(filePath)
    };
  } catch (error) {
    return { ok: false, message: "Could not load that file. Please pick a valid image." };
  }
});

ipcMain.handle("file:savePng", async (_, payload) => {
  const { suggestedName, base64Png } = payload;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export High Quality Render",
    defaultPath: suggestedName || "lighting-render.png",
    filters: [{ name: "PNG Image", extensions: ["png"] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await fs.promises.writeFile(result.filePath, Buffer.from(base64Png, "base64"));
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, message: "Failed to export PNG. Please try another location." };
  }
});

ipcMain.handle("state:save", async (_, state) => {
  try {
    await fs.promises.writeFile(STATE_FILE(), JSON.stringify(state, null, 2), "utf-8");
    return { ok: true };
  } catch (error) {
    return { ok: false };
  }
});

ipcMain.handle("state:load", async () => {
  try {
    const raw = await fs.promises.readFile(STATE_FILE(), "utf-8");
    return { ok: true, state: JSON.parse(raw) };
  } catch {
    return { ok: true, state: null };
  }
});

ipcMain.handle("app:getDefaultAssets", async () => {
  const base = app.getAppPath();
  return {
    baseTexturePath: path.join(base, "assets", "sample_base_texture.png"),
    normalMapPath: path.join(base, "assets", "sample_normal_map.png"),
    goboPath: path.join(base, "assets", "sample_gobo.png")
  };
});

ipcMain.handle("app:reloadCode", async () => {
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
