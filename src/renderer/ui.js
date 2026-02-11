import { LightingRenderer } from "./renderer.js";

const GEL_PRESETS = [
  { name: "None (Open White)", hex: "#ffffff" },
  { name: "Rosco R02 Bastard Amber (Approx)", hex: "#ffd8a6" },
  { name: "Rosco R27 Medium Red (Approx)", hex: "#ff5a5a" },
  { name: "Rosco R80 Primary Blue (Approx)", hex: "#3f5dff" },
  { name: "Lee 201 Full CTB (Approx)", hex: "#a4c7ff" },
  { name: "Lee 103 Straw (Approx)", hex: "#ffd875" },
  { name: "Lee 124 Dark Green (Approx)", hex: "#4f9f66" }
];

const defaults = {
  baseTexturePath: "",
  normalMapPath: "",
  roughnessMapPath: "",
  metalnessMapPath: "",
  aoMapPath: "",
  displacementMapPath: "",
  goboPath: "",
  lightColorHex: "#ffd6a8",
  kelvin: 3200,
  lux: 900,
  azimuth: 0,
  elevation: 18,
  beamAngle: 44,
  softness: 0.35,
  throwDistance: 3.2,
  tilingScale: 1.0,
  displacementScale: 0.03,
  ambientFill: 2,
  gelPresetName: "None (Open White)",
  gelHex: "#ffffff",
  goboScale: 1.0,
  goboRotation: 0,
  goboFocus: 0.5,
  goboInvert: false,
  renderResolution: "1920×1080",
  camera: null
};

const state = { ...defaults };

let engine = null;
let isRendering = false;
let defaultsFromApp = null;

function $(id) {
  return document.getElementById(id);
}

function on(id, event, handler) {
  const el = $(id);
  if (!el) return null;
  el.addEventListener(event, handler);
  return el;
}

function setStatus(message, isError = false) {
  const el = $("statusLine");
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? "var(--error)" : "var(--muted)";
}

function setProgress(value) {
  const p = $("renderProgress");
  if (p) p.value = value;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeHex(input, fallback = "#ffffff") {
  const text = (input || "").trim();
  const ok = /^#([a-fA-F0-9]{6})$/.test(text);
  return ok ? text.toLowerCase() : fallback;
}

function hexToRgb(hex) {
  const clean = sanitizeHex(hex).slice(1);
  const n = parseInt(clean, 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255
  };
}

function rgbToHex(r, g, b) {
  const c = (v) => v.toString(16).padStart(2, "0");
  return `#${c(clamp(Math.round(r), 0, 255))}${c(clamp(Math.round(g), 0, 255))}${c(clamp(Math.round(b), 0, 255))}`;
}

function multiplyHex(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex((a.r * b.r) / 255, (a.g * b.g) / 255, (a.b * b.b) / 255);
}

function kelvinToHex(kelvin) {
  const k = clamp(kelvin, 1000, 40000) / 100;
  let r;
  let g;
  let b;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
    b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
    b = 255;
  }
  return rgbToHex(r, g, b);
}

function finalLightHex() {
  return multiplyHex(state.lightColorHex, state.gelHex);
}

function parseResolution(text) {
  const [w, h] = text.split("×");
  return { width: Number(w), height: Number(h) };
}

function persistStateSoon() {
  if (!engine) return;
  const snapshot = { ...state, camera: engine.getCameraState() };
  window.appApi.saveState(snapshot);
}

function bindRangeAndNumber(rangeId, numberId, onValue) {
  const range = $(rangeId);
  const number = $(numberId);
  if (!range || !number) return;
  const apply = (raw) => {
    try {
      range.value = raw;
      number.value = raw;
      onValue(Number(raw));
      persistStateSoon();
    } catch (error) {
      setStatus(`Control error: ${error?.message || "unknown"}`, true);
    }
  };
  range.addEventListener("input", () => apply(range.value));
  number.addEventListener("input", () => apply(number.value));
}

function updatePathLabels() {
  const base = $("baseTexturePathLabel");
  const normal = $("normalMapPathLabel");
  const rough = $("roughnessMapPathLabel");
  const metal = $("metalnessMapPathLabel");
  const ao = $("aoMapPathLabel");
  const disp = $("displacementMapPathLabel");
  const gobo = $("goboPathLabel");
  if (base) base.textContent = state.baseTexturePath || "No base texture selected";
  if (normal) normal.textContent = state.normalMapPath || "No normal map selected";
  if (rough) rough.textContent = state.roughnessMapPath || "No roughness map selected";
  if (metal) metal.textContent = state.metalnessMapPath || "No metalness map selected";
  if (ao) ao.textContent = state.aoMapPath || "No AO map selected";
  if (disp) disp.textContent = state.displacementMapPath || "No displacement map selected";
  if (gobo) gobo.textContent = state.goboPath || "No gobo selected";
}

function pushLightingToRenderer() {
  try {
    engine.applyLightingState({
      ...state,
      finalLightColorHex: finalLightHex()
    });
    $("directionIndicator").textContent = `Direction: Az ${state.azimuth.toFixed(0)}°, El ${state.elevation.toFixed(0)}°, Beam ${state.beamAngle.toFixed(0)}°`;
  } catch (error) {
    setStatus(`Light update error: ${error?.message || "unknown"}`, true);
  }
}

async function loadBaseTexture(pathValue) {
  try {
    await engine.loadBaseTexture(pathValue);
    engine.applyTiling(state.tilingScale);
    state.baseTexturePath = pathValue;
    updatePathLabels();
    setStatus("Base texture loaded.");
  } catch {
    setStatus("Could not load that base texture. Please use PNG/JPG/JPEG.", true);
  }
}

async function loadNormalMap(pathValue) {
  try {
    await engine.loadNormalTexture(pathValue);
    engine.applyTiling(state.tilingScale);
    state.normalMapPath = pathValue;
    updatePathLabels();
    setStatus("Normal map loaded.");
  } catch {
    setStatus("Could not load that normal map. Supported: EXR, PNG, JPG.", true);
  }
}

async function loadGobo(pathValue) {
  try {
    await engine.loadGoboImage(pathValue, {
      scale: state.goboScale,
      rotation: state.goboRotation,
      focus: state.goboFocus,
      invert: state.goboInvert
    });
    state.goboPath = pathValue;
    updatePathLabels();
    setStatus("Gobo loaded.");
  } catch {
    setStatus("Could not load that gobo. Please use a black-and-white image.", true);
  }
}

async function loadPbrMap(pathValue, kind) {
  try {
    await engine.loadPbrTexture(pathValue, kind);
    if (kind === "roughness") state.roughnessMapPath = pathValue;
    if (kind === "metalness") state.metalnessMapPath = pathValue;
    if (kind === "ao") state.aoMapPath = pathValue;
    if (kind === "displacement") state.displacementMapPath = pathValue;
    engine.applyTiling(state.tilingScale);
    engine.setDisplacementScale(state.displacementScale);
    updatePathLabels();
    setStatus(`${kind[0].toUpperCase() + kind.slice(1)} map loaded.`);
  } catch {
    setStatus(`Could not load ${kind} map. Supported: EXR, PNG, JPG.`, true);
  }
}

function applyGoboControls() {
  engine.updateGoboTexture({
    scale: state.goboScale,
    rotation: state.goboRotation,
    focus: state.goboFocus,
    invert: state.goboInvert
  });
}

function resetLightStateToDefaults() {
  state.lightColorHex = defaults.lightColorHex;
  state.kelvin = defaults.kelvin;
  state.lux = defaults.lux;
  state.azimuth = defaults.azimuth;
  state.elevation = defaults.elevation;
  state.beamAngle = defaults.beamAngle;
  state.softness = defaults.softness;
  state.throwDistance = defaults.throwDistance;
  state.tilingScale = defaults.tilingScale;
  state.displacementScale = defaults.displacementScale;
  state.ambientFill = defaults.ambientFill;
  state.gelPresetName = defaults.gelPresetName;
  state.gelHex = defaults.gelHex;
  state.goboScale = defaults.goboScale;
  state.goboRotation = defaults.goboRotation;
  state.goboFocus = defaults.goboFocus;
  state.goboInvert = defaults.goboInvert;
}

function syncUiFromState() {
  $("lightColorHex").value = state.lightColorHex;
  $("lightColorPicker").value = state.lightColorHex;
  $("kelvinSlider").value = String(state.kelvin);
  $("kelvinNumber").value = String(state.kelvin);
  $("luxSlider").value = String(state.lux);
  $("luxNumber").value = String(state.lux);
  $("azimuthSlider").value = String(state.azimuth);
  $("azimuthNumber").value = String(state.azimuth);
  $("elevationSlider").value = String(state.elevation);
  $("elevationNumber").value = String(state.elevation);
  $("beamAngleSlider").value = String(state.beamAngle);
  $("beamAngleNumber").value = String(state.beamAngle);
  $("softnessSlider").value = String(state.softness);
  $("softnessNumber").value = String(state.softness);
  $("distanceSlider").value = String(state.throwDistance);
  $("distanceNumber").value = String(state.throwDistance);
  $("tilingScaleSlider").value = String(state.tilingScale);
  $("tilingScaleNumber").value = String(state.tilingScale);
  $("displacementScaleSlider").value = String(state.displacementScale);
  $("displacementScaleNumber").value = String(state.displacementScale);
  $("ambientSlider").value = String(state.ambientFill);
  $("ambientNumber").value = String(state.ambientFill);
  $("gelHex").value = state.gelHex;
  $("gelColorPicker").value = state.gelHex;
  $("goboScaleSlider").value = String(state.goboScale);
  $("goboScaleNumber").value = String(state.goboScale);
  $("goboRotationSlider").value = String(state.goboRotation);
  $("goboRotationNumber").value = String(state.goboRotation);
  $("goboFocusSlider").value = String(state.goboFocus);
  $("goboFocusNumber").value = String(state.goboFocus);
  $("goboInvert").checked = state.goboInvert;
  $("renderResolution").value = state.renderResolution;
  $("gelPreset").value = state.gelPresetName;
  updatePathLabels();
}

function initGelDropdown() {
  const select = $("gelPreset");
  select.innerHTML = "";
  GEL_PRESETS.forEach((g) => {
    const option = document.createElement("option");
    option.value = g.name;
    option.textContent = `${g.name} (${g.hex})`;
    select.appendChild(option);
  });
}

function setBusyRenderUI(busy) {
  isRendering = busy;
  $("hqRenderButton").disabled = busy;
  $("cancelRenderButton").disabled = !busy;
}

async function handleReloadTextures() {
  if (state.baseTexturePath) await loadBaseTexture(state.baseTexturePath);
  if (state.normalMapPath) await loadNormalMap(state.normalMapPath);
  if (state.roughnessMapPath) await loadPbrMap(state.roughnessMapPath, "roughness");
  if (state.metalnessMapPath) await loadPbrMap(state.metalnessMapPath, "metalness");
  if (state.aoMapPath) await loadPbrMap(state.aoMapPath, "ao");
  if (state.displacementMapPath) await loadPbrMap(state.displacementMapPath, "displacement");
  engine.applyTiling(state.tilingScale);
  engine.setDisplacementScale(state.displacementScale);
  setStatus("Reloaded texture files from disk paths.");
}

async function bootstrap() {
  initGelDropdown();
  let loaded = { ok: true, state: null };
  try {
    loaded = (await window.appApi?.loadState?.()) || loaded;
  } catch {
    loaded = { ok: true, state: null };
  }
  try {
    defaultsFromApp = (await window.appApi?.getDefaultAssets?.()) || {};
  } catch {
    defaultsFromApp = {};
  }
  const hasSavedState = Boolean(loaded && loaded.ok && loaded.state);
  if (loaded.ok && loaded.state) Object.assign(state, defaults, loaded.state);
  if (!state.baseTexturePath && defaultsFromApp.baseTexturePath) state.baseTexturePath = defaultsFromApp.baseTexturePath;
  // Only auto-apply sample normal map on first-ever run. If user cleared it, keep it cleared.
  if (!hasSavedState && !state.normalMapPath && defaultsFromApp.normalMapPath) {
    state.normalMapPath = defaultsFromApp.normalMapPath;
  }

  engine = new LightingRenderer($("viewport"), { onStatus: setStatus, onProgress: setProgress });
  engine.applyCameraState(state.camera);

  syncUiFromState();
  await loadBaseTexture(state.baseTexturePath);
  if (state.normalMapPath) await loadNormalMap(state.normalMapPath);
  if (state.roughnessMapPath) await loadPbrMap(state.roughnessMapPath, "roughness");
  if (state.metalnessMapPath) await loadPbrMap(state.metalnessMapPath, "metalness");
  if (state.aoMapPath) await loadPbrMap(state.aoMapPath, "ao");
  if (state.displacementMapPath) await loadPbrMap(state.displacementMapPath, "displacement");
  engine.applyTiling(state.tilingScale);
  engine.setDisplacementScale(state.displacementScale);
  if (state.goboPath) await loadGobo(state.goboPath);
  else engine.clearGobo();
  pushLightingToRenderer();
  persistStateSoon();

  bindRangeAndNumber("kelvinSlider", "kelvinNumber", (v) => {
    state.kelvin = clamp(v, 1800, 12000);
    state.lightColorHex = kelvinToHex(state.kelvin);
    $("lightColorHex").value = state.lightColorHex;
    $("lightColorPicker").value = state.lightColorHex;
    pushLightingToRenderer();
  });
  bindRangeAndNumber("luxSlider", "luxNumber", (v) => {
    state.lux = clamp(v, 1, 4000);
    pushLightingToRenderer();
  });
  bindRangeAndNumber("azimuthSlider", "azimuthNumber", (v) => {
    state.azimuth = clamp(v, -80, 80);
    pushLightingToRenderer();
  });
  bindRangeAndNumber("elevationSlider", "elevationNumber", (v) => {
    state.elevation = clamp(v, -30, 70);
    pushLightingToRenderer();
  });
  bindRangeAndNumber("beamAngleSlider", "beamAngleNumber", (v) => {
    state.beamAngle = clamp(v, 10, 80);
    pushLightingToRenderer();
  });
  bindRangeAndNumber("softnessSlider", "softnessNumber", (v) => {
    state.softness = clamp(v, 0, 1);
    pushLightingToRenderer();
    applyGoboControls();
  });
  bindRangeAndNumber("distanceSlider", "distanceNumber", (v) => {
    state.throwDistance = clamp(v, 1.2, 8);
    pushLightingToRenderer();
  });
  bindRangeAndNumber("tilingScaleSlider", "tilingScaleNumber", (v) => {
    state.tilingScale = clamp(v, 0.25, 8);
    engine.applyTiling(state.tilingScale);
  });
  bindRangeAndNumber("displacementScaleSlider", "displacementScaleNumber", (v) => {
    state.displacementScale = clamp(v, 0, 0.2);
    engine.setDisplacementScale(state.displacementScale);
  });
  bindRangeAndNumber("ambientSlider", "ambientNumber", (v) => {
    state.ambientFill = clamp(v, 0, 10);
    pushLightingToRenderer();
  });
  bindRangeAndNumber("goboScaleSlider", "goboScaleNumber", (v) => {
    state.goboScale = clamp(v, 0.3, 3.0);
    applyGoboControls();
  });
  bindRangeAndNumber("goboRotationSlider", "goboRotationNumber", (v) => {
    state.goboRotation = clamp(v, -180, 180);
    applyGoboControls();
  });
  bindRangeAndNumber("goboFocusSlider", "goboFocusNumber", (v) => {
    state.goboFocus = clamp(v, 0, 8);
    applyGoboControls();
  });

  on("goboInvert", "change", () => {
    state.goboInvert = $("goboInvert").checked;
    applyGoboControls();
    persistStateSoon();
  });

  on("lightColorHex", "change", () => {
    state.lightColorHex = sanitizeHex($("lightColorHex").value, state.lightColorHex);
    $("lightColorHex").value = state.lightColorHex;
    $("lightColorPicker").value = state.lightColorHex;
    pushLightingToRenderer();
    persistStateSoon();
  });
  on("lightColorPicker", "input", () => {
    state.lightColorHex = sanitizeHex($("lightColorPicker").value, state.lightColorHex);
    $("lightColorHex").value = state.lightColorHex;
    pushLightingToRenderer();
    persistStateSoon();
  });

  on("gelPreset", "change", () => {
    state.gelPresetName = $("gelPreset").value;
    const found = GEL_PRESETS.find((g) => g.name === state.gelPresetName);
    if (found) {
      state.gelHex = found.hex.toLowerCase();
      $("gelHex").value = state.gelHex;
      $("gelColorPicker").value = state.gelHex;
    }
    pushLightingToRenderer();
    persistStateSoon();
  });
  on("gelHex", "change", () => {
    state.gelHex = sanitizeHex($("gelHex").value, state.gelHex);
    state.gelPresetName = "None (Open White)";
    $("gelPreset").value = "None (Open White)";
    $("gelHex").value = state.gelHex;
    $("gelColorPicker").value = state.gelHex;
    pushLightingToRenderer();
    persistStateSoon();
  });
  on("gelColorPicker", "input", () => {
    state.gelHex = sanitizeHex($("gelColorPicker").value, state.gelHex);
    state.gelPresetName = "None (Open White)";
    $("gelPreset").value = "None (Open White)";
    $("gelHex").value = state.gelHex;
    pushLightingToRenderer();
    persistStateSoon();
  });

  on("renderResolution", "change", () => {
    state.renderResolution = $("renderResolution").value;
    persistStateSoon();
  });

  on("loadBaseTexture", "click", async () => {
    const filePath = await window.appApi.pickFile({
      title: "Select Base Texture",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }]
    });
    if (!filePath) return;
    await loadBaseTexture(filePath);
    persistStateSoon();
  });

  on("loadNormalMap", "click", async () => {
    const filePath = await window.appApi.pickFile({
      title: "Select Normal Map",
      filters: [{ name: "Normal Map", extensions: ["exr", "png", "jpg", "jpeg"] }]
    });
    if (!filePath) return;
    await loadNormalMap(filePath);
    persistStateSoon();
  });

  on("loadRoughnessMap", "click", async () => {
    const filePath = await window.appApi.pickFile({
      title: "Select Roughness Map",
      filters: [{ name: "PBR Map", extensions: ["exr", "png", "jpg", "jpeg"] }]
    });
    if (!filePath) return;
    await loadPbrMap(filePath, "roughness");
    persistStateSoon();
  });

  on("loadMetalnessMap", "click", async () => {
    const filePath = await window.appApi.pickFile({
      title: "Select Metalness Map",
      filters: [{ name: "PBR Map", extensions: ["exr", "png", "jpg", "jpeg"] }]
    });
    if (!filePath) return;
    await loadPbrMap(filePath, "metalness");
    persistStateSoon();
  });

  on("loadAoMap", "click", async () => {
    const filePath = await window.appApi.pickFile({
      title: "Select AO Map",
      filters: [{ name: "PBR Map", extensions: ["exr", "png", "jpg", "jpeg"] }]
    });
    if (!filePath) return;
    await loadPbrMap(filePath, "ao");
    persistStateSoon();
  });

  on("loadDisplacementMap", "click", async () => {
    const filePath = await window.appApi.pickFile({
      title: "Select Displacement Map",
      filters: [{ name: "PBR Map", extensions: ["exr", "png", "jpg", "jpeg"] }]
    });
    if (!filePath) return;
    await loadPbrMap(filePath, "displacement");
    persistStateSoon();
  });

  on("clearNormalMap", "click", () => {
    state.normalMapPath = "";
    engine.clearNormalTexture();
    updatePathLabels();
    setStatus("Normal map cleared.");
    persistStateSoon();
  });

  on("clearPbrMaps", "click", () => {
    state.roughnessMapPath = "";
    state.metalnessMapPath = "";
    state.aoMapPath = "";
    state.displacementMapPath = "";
    engine.clearPbrTextures();
    updatePathLabels();
    setStatus("PBR maps cleared.");
    persistStateSoon();
  });

  on("loadGobo", "click", async () => {
    const filePath = await window.appApi.pickFile({
      title: "Select Gobo Mask",
      filters: [{ name: "Gobo Image", extensions: ["png", "jpg", "jpeg"] }]
    });
    if (!filePath) return;
    await loadGobo(filePath);
    persistStateSoon();
  });

  on("clearGobo", "click", () => {
    state.goboPath = "";
    engine.clearGobo();
    updatePathLabels();
    setStatus("Gobo cleared.");
    persistStateSoon();
  });

  on("hqRenderButton", "click", async () => {
    if (isRendering) return;
    setBusyRenderUI(true);
    setStatus("Rendering high quality still...");
    try {
      const { width, height } = parseResolution($("renderResolution").value);
      const result = await engine.renderHighQuality(
        { ...state, finalLightColorHex: finalLightHex() },
        width,
        height
      );
      if (result.ok) {
        $("exportButton").disabled = false;
        setProgress(100);
        if (result.fallback) {
          setStatus("HQ fallback render completed (reduced quality for stability).");
        }
      } else {
        setProgress(0);
        if (!result.canceled) {
          setStatus(result.message || "High quality render failed. Please try again.", true);
        }
      }
    } catch {
      setProgress(0);
      setStatus("High quality render failed unexpectedly. Please try again.", true);
    } finally {
      setBusyRenderUI(false);
    }
  });

  on("cancelRenderButton", "click", () => {
    if (isRendering) engine.requestCancelRender();
  });

  on("exportButton", "click", async () => {
    if (!engine.lastRenderBase64) {
      setStatus("Run a high quality render before exporting.", true);
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const response = await window.appApi.savePng({
      suggestedName: `lighting-render-${stamp}.png`,
      base64Png: engine.lastRenderBase64
    });
    if (response.ok) setStatus(`Exported: ${response.filePath}`);
    else if (!response.canceled) setStatus(response.message || "Could not export PNG.", true);
  });

  const cogBtn = $("cogButton");
  const cogMenu = $("cogMenu");
  if (cogBtn && cogMenu) {
    cogBtn.addEventListener("click", () => cogMenu.classList.toggle("hidden"));
    window.addEventListener("click", (e) => {
      if (!cogMenu.contains(e.target) && e.target !== cogBtn) cogMenu.classList.add("hidden");
    });
    cogMenu.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        cogMenu.classList.add("hidden");
        const action = btn.dataset.action;
        if (action === "reloadTextures") {
          await handleReloadTextures();
        } else if (action === "reloadModel") {
          engine.resetModel();
          await handleReloadTextures();
          setStatus("Wall model reset and textures re-applied.");
        } else if (action === "reloadLight") {
          resetLightStateToDefaults();
          state.goboPath = "";
          syncUiFromState();
          pushLightingToRenderer();
          engine.clearGobo();
          setStatus("Light and theatre settings reset to defaults.");
        } else if (action === "reloadCode") {
          await window.appApi.saveState({ ...state, camera: engine.getCameraState() });
          await window.appApi.reloadCode();
        }
        persistStateSoon();
      });
    });
  }

  setInterval(() => persistStateSoon(), 3000);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Bootstrap error:", error);
  setStatus(`Init error: ${error?.message || "unknown"}`, true);
});

window.addEventListener("error", (event) => {
  // eslint-disable-next-line no-console
  console.error("Runtime error event:", event.error || event.message);
  setStatus(`Runtime error: ${event.message}`, true);
});
