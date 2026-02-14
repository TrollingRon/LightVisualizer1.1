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
  houseLightColorHex: "#fff1d6",
  houseLightIntensity: 0.08,
  hazeEnabled: true,
  hazeQuality: "Medium",
  hazeDensity: 0.35,
  hazeHeight: 1.2,
  textureQuality: "Fast",
  tilingScale: 1.0,
  displacementScale: 0.03,
  ambientFill: 2,
  gelPresetName: "None (Open White)",
  gelHex: "#ffffff",
  goboScale: 1.0,
  goboRotation: 0,
  goboFocus: 0.5,
  goboInvert: false,
  fpsCounterEnabled: false,
  renderResolution: "1920×1080",
  camera: null
};

const state = { ...defaults };
const START_WITH_BLANK_SLATE = true;

let engine = null;
let isRendering = false;
let defaultsFromApp = null;
let loadingDepth = 0;
let loadingFailsafeTimer = null;
let loadingPercentValue = 0;
let goboUpdateTimer = null;

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

function updateFpsDisplay(fpsValue) {
  const el = $("fpsCounter");
  if (!el) return;
  el.textContent = `FPS: ${Math.max(0, Math.round(fpsValue))}`;
}

function applyFpsVisibility() {
  const el = $("fpsCounter");
  const btn = $("toggleFpsButton");
  if (!el) return;
  if (state.fpsCounterEnabled) {
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
  if (engine && typeof engine.setFpsEnabled === "function") {
    engine.setFpsEnabled(state.fpsCounterEnabled);
  }
  if (btn) btn.textContent = state.fpsCounterEnabled ? "Hide FPS" : "Show FPS";
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function setLoadingOverlayStatus(message = null, percent = null) {
  const msg = $("loadingMessage");
  const pct = $("loadingPercent");
  if (message !== null && msg) msg.textContent = message;
  if (percent !== null) loadingPercentValue = clampPercent(percent);
  if (pct) pct.textContent = `${loadingPercentValue}%`;
}

function startLoading(message = "Loading...", percent = 0) {
  loadingDepth += 1;
  document.body.classList.add("app-loading");
  const overlay = $("loadingOverlay");
  setLoadingOverlayStatus(message, percent);
  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.style.display = "grid";
  }
  if (loadingFailsafeTimer) clearTimeout(loadingFailsafeTimer);
  loadingFailsafeTimer = setTimeout(() => {
    forceHideLoading();
    setStatus("Loading timeout recovered.", true);
  }, 45000);
}

function stopLoading() {
  loadingDepth = Math.max(0, loadingDepth - 1);
  if (loadingDepth > 0) return;
  document.body.classList.remove("app-loading");
  const overlay = $("loadingOverlay");
  if (overlay) {
    overlay.classList.add("hidden");
    overlay.style.display = "none";
  }
  if (loadingFailsafeTimer) {
    clearTimeout(loadingFailsafeTimer);
    loadingFailsafeTimer = null;
  }
}

function forceHideLoading() {
  loadingDepth = 0;
  document.body.classList.remove("app-loading");
  const overlay = $("loadingOverlay");
  if (overlay) {
    overlay.classList.add("hidden");
    overlay.style.display = "none";
  }
  if (loadingFailsafeTimer) {
    clearTimeout(loadingFailsafeTimer);
    loadingFailsafeTimer = null;
  }
}

async function withLoading(message, fn, startPercent = 5) {
  startLoading(message, startPercent);
  try {
    return await fn();
  } finally {
    setLoadingOverlayStatus(null, 100);
    stopLoading();
  }
}

function initLoadingLogo() {
  const img = $("loadingLogoImg");
  const txt = $("loadingLogoText");
  if (!img || !txt) return;
  const candidates = [
    "../../assets/logo.png",
    "../../assets/icon.png",
    "../../assets/app_logo.png",
    "../../assets/lighting-texture-previewer.png",
    "../../assets/LightingTexturePreviewer.png"
  ];
  candidates.forEach((src) => {
    const probe = new Image();
    probe.onload = () => {
      if (!img.classList.contains("hidden")) return;
      img.src = src;
      img.classList.remove("hidden");
      txt.classList.add("hidden");
    };
    probe.src = src;
  });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeTextureQuality(v) {
  return v === "Fast" || v === "High" || v === "Ultra" ? v : "Balanced";
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
  if (START_WITH_BLANK_SLATE) return;
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

function applyTextureQualityToRenderer() {
  if (!engine || typeof engine.setTextureQuality !== "function") return;
  state.textureQuality = normalizeTextureQuality(state.textureQuality);
  engine.setTextureQuality(state.textureQuality);
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

async function loadBaseTexture(pathValue, showLoader = true) {
  const run = async () => {
  try {
    await engine.loadBaseTexture(pathValue);
    engine.applyTiling(state.tilingScale);
    state.baseTexturePath = pathValue;
    updatePathLabels();
    setStatus("Base texture loaded.");
  } catch {
    setStatus("Could not load that base texture. Please use PNG/JPG/JPEG.", true);
  }
  };
  return showLoader ? withLoading("Loading base texture...", run) : run();
}

async function loadNormalMap(pathValue, showLoader = true) {
  const run = async () => {
  try {
    await engine.loadNormalTexture(pathValue);
    engine.applyTiling(state.tilingScale);
    state.normalMapPath = pathValue;
    updatePathLabels();
    setStatus("Normal map loaded.");
  } catch {
    setStatus("Could not load that normal map. Supported: EXR, PNG, JPG.", true);
  }
  };
  return showLoader ? withLoading("Loading normal map...", run) : run();
}

async function loadGobo(pathValue, showLoader = true) {
  const run = async () => {
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
  };
  return showLoader ? withLoading("Loading gobo...", run) : run();
}

async function loadPbrMap(pathValue, kind, showLoader = true) {
  const run = async () => {
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
  };
  return showLoader ? withLoading(`Loading ${kind} map...`, run) : run();
}

async function loadMaterialPackage(zipPath) {
  return withLoading("Loading material package...", async () => {
  // Reset previous material maps first so old detail does not bleed into the next package.
  engine.clearBaseTexture();
  engine.clearNormalTexture();
  engine.clearPbrTextures();
  state.baseTexturePath = "";
  state.normalMapPath = "";
  state.roughnessMapPath = "";
  state.metalnessMapPath = "";
  state.aoMapPath = "";
  state.displacementMapPath = "";
  updatePathLabels();

  setLoadingOverlayStatus("Extracting material package...", 8);
  const extracted = await window.appApi.extractMaterialPackage(zipPath);
  if (!extracted?.ok) {
    throw new Error(extracted?.message || "Could not extract package.");
  }

  setLoadingOverlayStatus("Loading base color...", 28);
  await loadBaseTexture(extracted.baseTexturePath, false);
  state.baseTexturePath = extracted.baseTexturePath;

  let done = 0;
  const optionalTotal = [
    extracted.normalMapPath,
    extracted.roughnessMapPath,
    extracted.metalnessMapPath,
    extracted.aoMapPath,
    extracted.displacementMapPath
  ].filter(Boolean).length;
  const updateOptionalProgress = (label) => {
    done += 1;
    const ratio = optionalTotal > 0 ? done / optionalTotal : 1;
    setLoadingOverlayStatus(`Loading ${label} (${done}/${optionalTotal})...`, 28 + ratio * 64);
  };

  if (extracted.normalMapPath) {
    await loadNormalMap(extracted.normalMapPath, false);
    state.normalMapPath = extracted.normalMapPath;
    updateOptionalProgress("normal map");
  } else {
    state.normalMapPath = "";
    engine.clearNormalTexture();
  }

  const loadPacked = async (filePath, kind, stateKey) => {
    if (!filePath) {
      state[stateKey] = "";
      return;
    }
    await loadPbrMap(filePath, kind, false);
    state[stateKey] = filePath;
    updateOptionalProgress(`${kind} map`);
  };

  await loadPacked(extracted.roughnessMapPath, "roughness", "roughnessMapPath");
  await loadPacked(extracted.metalnessMapPath, "metalness", "metalnessMapPath");
  await loadPacked(extracted.aoMapPath, "ao", "aoMapPath");
  await loadPacked(extracted.displacementMapPath, "displacement", "displacementMapPath");

  engine.applyTiling(state.tilingScale);
  engine.setDisplacementScale(state.displacementScale);
  updatePathLabels();
  setLoadingOverlayStatus("Finalizing material package...", 100);
  });
}

function applyGoboControls(immediate = false) {
  const run = () => engine.updateGoboTexture({
    scale: state.goboScale,
    rotation: state.goboRotation,
    focus: state.goboFocus,
    invert: state.goboInvert
  });
  if (goboUpdateTimer) {
    clearTimeout(goboUpdateTimer);
    goboUpdateTimer = null;
  }
  if (immediate) {
    run();
    return;
  }
  goboUpdateTimer = setTimeout(() => {
    goboUpdateTimer = null;
    run();
  }, 40);
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
  state.houseLightColorHex = defaults.houseLightColorHex;
  state.houseLightIntensity = defaults.houseLightIntensity;
  state.hazeEnabled = defaults.hazeEnabled;
  state.hazeQuality = defaults.hazeQuality;
  state.hazeDensity = defaults.hazeDensity;
  state.hazeHeight = defaults.hazeHeight;
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
  $("houseLightColorHex").value = state.houseLightColorHex;
  $("houseLightColorPicker").value = state.houseLightColorHex;
  $("houseLightIntensitySlider").value = String(state.houseLightIntensity);
  $("houseLightIntensityNumber").value = String(state.houseLightIntensity);
  $("hazeEnabled").checked = Boolean(state.hazeEnabled);
  $("hazeQuality").value = state.hazeQuality;
  $("hazeDensitySlider").value = String(state.hazeDensity);
  $("hazeDensityNumber").value = String(state.hazeDensity);
  $("hazeHeightSlider").value = String(state.hazeHeight);
  $("hazeHeightNumber").value = String(state.hazeHeight);
  $("textureQuality").value = normalizeTextureQuality(state.textureQuality);
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
  if (typeof state.fpsCounterEnabled !== "boolean") state.fpsCounterEnabled = false;
  $("renderResolution").value = state.renderResolution;
  $("gelPreset").value = state.gelPresetName;
  updatePathLabels();
  applyFpsVisibility();
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

function initCollapsiblePanels() {
  const panels = document.querySelectorAll(".sidebar > section.panel");
  panels.forEach((panel) => {
    const heading = panel.querySelector("h2");
    if (!heading) return;
    const title = (heading.textContent || "").trim();

    const header = document.createElement("button");
    header.type = "button";
    header.className = "panel-header";
    header.textContent = title;

    const content = document.createElement("div");
    content.className = "panel-content";

    let node = heading.nextSibling;
    while (node) {
      const next = node.nextSibling;
      content.appendChild(node);
      node = next;
    }

    panel.classList.add("collapsible");
    panel.classList.remove("expanded");
    heading.remove();
    panel.prepend(content);
    panel.prepend(header);

    header.addEventListener("click", () => {
      panel.classList.toggle("expanded");
    });
  });
}

function setBusyRenderUI(busy) {
  isRendering = busy;
  $("hqRenderButton").disabled = busy;
  $("cancelRenderButton").disabled = !busy;
}

async function handleReloadTextures() {
  startLoading("Reloading textures...", 0);
  try {
    const steps = [];
    if (state.baseTexturePath) steps.push({ label: "base texture", run: () => loadBaseTexture(state.baseTexturePath, false) });
    if (state.normalMapPath) steps.push({ label: "normal map", run: () => loadNormalMap(state.normalMapPath, false) });
    if (state.roughnessMapPath) steps.push({ label: "roughness map", run: () => loadPbrMap(state.roughnessMapPath, "roughness", false) });
    if (state.metalnessMapPath) steps.push({ label: "metalness map", run: () => loadPbrMap(state.metalnessMapPath, "metalness", false) });
    if (state.aoMapPath) steps.push({ label: "AO map", run: () => loadPbrMap(state.aoMapPath, "ao", false) });
    if (state.displacementMapPath) steps.push({ label: "displacement map", run: () => loadPbrMap(state.displacementMapPath, "displacement", false) });

    const total = steps.length || 1;
    let done = 0;
    for (const step of steps) {
      setLoadingOverlayStatus(`Reloading ${step.label}...`, (done / total) * 100);
      await step.run();
      done += 1;
      setLoadingOverlayStatus(`Reloaded ${step.label}.`, (done / total) * 100);
    }
    engine.applyTiling(state.tilingScale);
    engine.setDisplacementScale(state.displacementScale);
    setLoadingOverlayStatus("Finalizing reload...", 100);
    setStatus("Reloaded texture files from disk paths.");
  } finally {
    stopLoading();
  }
}

async function bootstrap() {
  startLoading("Launching Lighting Texture Previewer...", 0);
  try {
    setLoadingOverlayStatus("Preparing interface...", 4);
    initLoadingLogo();
    initGelDropdown();
    initCollapsiblePanels();

    setLoadingOverlayStatus("Loading saved settings...", 10);
    let loaded = { ok: true, state: null };
    if (!START_WITH_BLANK_SLATE) {
      try {
        loaded = (await window.appApi?.loadState?.()) || loaded;
      } catch {
        loaded = { ok: true, state: null };
      }
    }

    setLoadingOverlayStatus("Loading default assets...", 16);
    try {
      defaultsFromApp = (await window.appApi?.getDefaultAssets?.()) || {};
    } catch {
      defaultsFromApp = {};
    }
    const hasSavedState = Boolean(loaded && loaded.ok && loaded.state);
    if (START_WITH_BLANK_SLATE) {
      Object.assign(state, defaults);
      state.baseTexturePath = "";
      state.normalMapPath = "";
      state.roughnessMapPath = "";
      state.metalnessMapPath = "";
      state.aoMapPath = "";
      state.displacementMapPath = "";
      state.goboPath = "";
      state.hazeEnabled = false;
      state.hazeDensity = 0;
      state.camera = null;
    } else {
      if (loaded.ok && loaded.state) Object.assign(state, defaults, loaded.state);
      if (!state.baseTexturePath && defaultsFromApp.baseTexturePath) state.baseTexturePath = defaultsFromApp.baseTexturePath;
      // Only auto-apply sample normal map on first-ever run. If user cleared it, keep it cleared.
      if (!hasSavedState && !state.normalMapPath && defaultsFromApp.normalMapPath) {
        state.normalMapPath = defaultsFromApp.normalMapPath;
      }
    }

    setLoadingOverlayStatus("Initializing renderer...", 24);
    engine = new LightingRenderer($("viewport"), {
      onStatus: setStatus,
      onProgress: setProgress,
      onFps: updateFpsDisplay
    });
    applyTextureQualityToRenderer();
    engine.applyCameraState(state.camera);
    applyFpsVisibility();

    setLoadingOverlayStatus("Syncing controls...", 32);
    syncUiFromState();
    if (state.baseTexturePath) {
      setLoadingOverlayStatus("Loading base texture...", 40);
      await loadBaseTexture(state.baseTexturePath, false);
    } else {
      engine.previewMaterial.uniforms.hasBaseMap.value = 0;
      engine.previewMaterial.uniforms.baseMap.value = null;
      engine.hqMaterial.map = null;
      engine.hqMaterial.needsUpdate = true;
      setLoadingOverlayStatus("Starting with blank wall...", 40);
    }

    const optionalMaps = [];
    if (state.normalMapPath) optionalMaps.push({ label: "normal map", run: () => loadNormalMap(state.normalMapPath, false) });
    if (state.roughnessMapPath) optionalMaps.push({ label: "roughness map", run: () => loadPbrMap(state.roughnessMapPath, "roughness", false) });
    if (state.metalnessMapPath) optionalMaps.push({ label: "metalness map", run: () => loadPbrMap(state.metalnessMapPath, "metalness", false) });
    if (state.aoMapPath) optionalMaps.push({ label: "AO map", run: () => loadPbrMap(state.aoMapPath, "ao", false) });
    if (state.displacementMapPath) optionalMaps.push({ label: "displacement map", run: () => loadPbrMap(state.displacementMapPath, "displacement", false) });

    const optionalTotal = optionalMaps.length || 1;
    let optionalDone = 0;
    const optionalStart = 46;
    const optionalSpan = 34;
    if (optionalMaps.length > 0) {
      await Promise.all(
        optionalMaps.map(async (task) => {
          await task.run();
          optionalDone += 1;
          const pct = optionalStart + (optionalDone / optionalTotal) * optionalSpan;
          setLoadingOverlayStatus(`Loading ${task.label} (${optionalDone}/${optionalTotal})...`, pct);
        })
      );
    } else {
      setLoadingOverlayStatus("No optional maps to load.", optionalStart + optionalSpan);
    }

    setLoadingOverlayStatus("Applying scene settings...", 84);
    engine.applyTiling(state.tilingScale);
    engine.setDisplacementScale(state.displacementScale);
    if (state.goboPath) {
      setLoadingOverlayStatus("Loading gobo...", 90);
      await loadGobo(state.goboPath, false);
    }
    else engine.clearGobo();
    setLoadingOverlayStatus("Applying lighting and haze...", 95);
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
  });
  bindRangeAndNumber("distanceSlider", "distanceNumber", (v) => {
    state.throwDistance = clamp(v, 1.2, 8);
    pushLightingToRenderer();
  });
  bindRangeAndNumber("houseLightIntensitySlider", "houseLightIntensityNumber", (v) => {
    state.houseLightIntensity = clamp(v, 0, 5);
    pushLightingToRenderer();
  });
  bindRangeAndNumber("hazeDensitySlider", "hazeDensityNumber", (v) => {
    state.hazeDensity = clamp(v, 0, 1);
    pushLightingToRenderer();
  });
  bindRangeAndNumber("hazeHeightSlider", "hazeHeightNumber", (v) => {
    state.hazeHeight = clamp(v, 0, 2.4);
    pushLightingToRenderer();
  });
  on("hazeEnabled", "change", () => {
    state.hazeEnabled = $("hazeEnabled").checked;
    pushLightingToRenderer();
    persistStateSoon();
  });
  on("hazeQuality", "change", () => {
    const v = $("hazeQuality").value;
    state.hazeQuality = v === "Low" || v === "High" ? v : "Medium";
    pushLightingToRenderer();
    persistStateSoon();
  });
  on("textureQuality", "change", () => {
    const v = $("textureQuality").value;
    state.textureQuality = normalizeTextureQuality(v);
    applyTextureQualityToRenderer();
    setStatus(`Texture quality set to ${state.textureQuality}.`);
    persistStateSoon();
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
    applyGoboControls(true);
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
  on("houseLightColorHex", "change", () => {
    state.houseLightColorHex = sanitizeHex($("houseLightColorHex").value, state.houseLightColorHex);
    $("houseLightColorHex").value = state.houseLightColorHex;
    $("houseLightColorPicker").value = state.houseLightColorHex;
    pushLightingToRenderer();
    persistStateSoon();
  });
  on("houseLightColorPicker", "input", () => {
    state.houseLightColorHex = sanitizeHex($("houseLightColorPicker").value, state.houseLightColorHex);
    $("houseLightColorHex").value = state.houseLightColorHex;
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

  on("clearBaseTexture", "click", () => {
    state.baseTexturePath = "";
    engine.clearBaseTexture();
    updatePathLabels();
    setStatus("Base texture cleared.");
    persistStateSoon();
  });

  on("loadMaterialPackage", "click", async () => {
    const filePath = await window.appApi.pickFile({
      title: "Select Material Package (ZIP)",
      filters: [{ name: "Material Package", extensions: ["zip"] }]
    });
    if (!filePath) return;
    try {
      await loadMaterialPackage(filePath);
      setStatus("Material package loaded.");
      persistStateSoon();
    } catch (error) {
      setStatus(`Could not load package: ${error?.message || "unknown error"}`, true);
    }
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
    const bytes = await engine.getLastRenderBytes();
    if (!bytes) {
      setStatus("Run a high quality render before exporting.", true);
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const response = await window.appApi.savePng({
      suggestedName: `lighting-render-${stamp}.png`,
      bytes
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
          if (!START_WITH_BLANK_SLATE) {
            await window.appApi.saveState({ ...state, camera: engine.getCameraState() });
          }
          await window.appApi.reloadCode();
        } else if (action === "toggleFps") {
          state.fpsCounterEnabled = !state.fpsCounterEnabled;
          applyFpsVisibility();
          if (state.fpsCounterEnabled) {
            updateFpsDisplay(0);
          }
        }
        persistStateSoon();
      });
    });
  }

    setLoadingOverlayStatus("Ready.", 100);
    if (!START_WITH_BLANK_SLATE) {
      setInterval(() => persistStateSoon(), 3000);
    }
  } finally {
    stopLoading();
  }
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Bootstrap error:", error);
  forceHideLoading();
  setStatus(`Init error: ${error?.message || "unknown"}`, true);
});

window.addEventListener("error", (event) => {
  // eslint-disable-next-line no-console
  console.error("Runtime error event:", event.error || event.message);
  forceHideLoading();
  setStatus(`Runtime error: ${event.message}`, true);
});
