const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

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

function walkFiles(dirPath, out = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function pickByPatterns(files, patterns) {
  const imageFiles = files.filter((f) => /\.(png|jpg|jpeg|exr)$/i.test(f));
  for (const pattern of patterns) {
    for (const filePath of imageFiles) {
      const low = filePath.toLowerCase();
      if (pattern.test(low)) return filePath;
    }
  }
  return "";
}

async function cleanupLegacyTempPackages() {
  const root = path.join(os.tmpdir(), "lighting-texture-previewer");
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^pkg-\d+$/i.test(entry.name))
      .map((entry) => fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true })));
  } catch {
    // Ignore temp cleanup failures.
  }
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
    const view = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return {
      ok: true,
      bytes: view,
      ext,
      mime: extToMime(ext),
      name: path.basename(filePath)
    };
  } catch (error) {
    return { ok: false, message: "Could not load that file. Please pick a valid image." };
  }
});

ipcMain.handle("file:savePng", async (_, payload) => {
  const { suggestedName, base64Png, bytes } = payload;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export High Quality Render",
    defaultPath: suggestedName || "lighting-render.png",
    filters: [{ name: "PNG Image", extensions: ["png"] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    let output = null;
    if (bytes) {
      if (ArrayBuffer.isView(bytes)) output = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      else if (bytes instanceof ArrayBuffer) output = Buffer.from(bytes);
      else output = Buffer.from(bytes);
    } else if (base64Png) {
      output = Buffer.from(base64Png, "base64");
    } else {
      return { ok: false, message: "No PNG payload was provided." };
    }
    await fs.promises.writeFile(result.filePath, output);
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

ipcMain.handle("archive:extractMaterialPackage", async (_, zipPath) => {
  try {
    const tempRoot = path.join(os.tmpdir(), "lighting-texture-previewer", "material-cache", "current");
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const pwsh = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    await new Promise((resolve, reject) => {
      execFile(
        pwsh,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath "${zipPath.replace(/"/g, '""')}" -DestinationPath "${tempRoot.replace(/"/g, '""')}" -Force`
        ],
        { windowsHide: true },
        (err) => (err ? reject(err) : resolve())
      );
    });

    const files = walkFiles(tempRoot);
    const result = {
      baseTexturePath: pickByPatterns(files, [
        /basecolor/, /base_color/, /albedo/, /diffuse/, /base[-_ ]?colou?r/, /(^|[\\/_-])color([._-]|$)/
      ]),
      normalMapPath: pickByPatterns(files, [/normalgl/, /normal[_-]?ogl/, /normaldx/, /normal/, /_n\./, /nrm/]),
      roughnessMapPath: pickByPatterns(files, [/roughness/, /rough/]),
      metalnessMapPath: pickByPatterns(files, [/metalness/, /metallic/, /(^|\\|\/)metal\./]),
      aoMapPath: pickByPatterns(files, [
        /ambient[_-]?occlusion/,
        /ambientocclusion/,
        /(^|[\\/_-])ao([._-]|$)/,
        /occlusion/,
        /(^|\\|\/)ao\./
      ]),
      displacementMapPath: pickByPatterns(files, [/displacement/, /height/])
    };

    if (!result.baseTexturePath) {
      return { ok: false, message: "Could not find a base color texture in that ZIP." };
    }
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: "Could not extract material package." };
  }
});

app.whenReady().then(() => {
  cleanupLegacyTempPackages();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
