import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

const textureLoader = new THREE.TextureLoader();
const exrLoader = new EXRLoader();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function ensureTextureMatrix(texture) {
  if (!texture) return;
  if (!texture.matrix || !texture.matrix.elements) {
    texture.matrix = new THREE.Matrix3();
  }
  if (typeof texture.matrixAutoUpdate !== "boolean") {
    texture.matrixAutoUpdate = true;
  }
  if (texture.matrixAutoUpdate && typeof texture.updateMatrix === "function") {
    texture.updateMatrix();
  }
}

function base64ToUint8(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function vectorFromAzEl(azimuthDeg, elevationDeg) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el)
  ).normalize();
}

async function loadImageFromPath(filePath) {
  const res = await window.appApi.readBinaryFile(filePath);
  if (!res.ok) throw new Error(res.message || "Could not load image.");
  const bytes = base64ToUint8(res.data);
  const blob = new Blob([bytes], { type: res.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode image."));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadTextureFromPath(filePath, options = {}) {
  const { srgb = false, exr = false } = options;
  const res = await window.appApi.readBinaryFile(filePath);
  if (!res.ok) throw new Error(res.message || "Could not load file.");
  const bytes = base64ToUint8(res.data);

  if (exr) {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const tex = exrLoader.parse(arrayBuffer);
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  const blob = new Blob([bytes], { type: res.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  try {
    const tex = await textureLoader.loadAsync(url);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 4;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function buildPreviewMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      baseMap: { value: null },
      hasBaseMap: { value: 0 },
      lightColor: { value: new THREE.Color("#ffd6a8") },
      ambientFill: { value: 0.02 },
      lightGain: { value: 0.75 },
      spotCenter: { value: new THREE.Vector2(0.5, 0.48) },
      radius: { value: 0.36 },
      softness: { value: 0.35 },
      goboMap: { value: null },
      hasGobo: { value: 0 },
      goboScale: { value: 1.0 },
      goboRotation: { value: 0.0 },
      goboInvert: { value: 0.0 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D baseMap;
      uniform float hasBaseMap;
      uniform vec3 lightColor;
      uniform float ambientFill;
      uniform float lightGain;
      uniform vec2 spotCenter;
      uniform float radius;
      uniform float softness;
      uniform sampler2D goboMap;
      uniform float hasGobo;
      uniform float goboScale;
      uniform float goboRotation;
      uniform float goboInvert;

      vec2 rotate2D(vec2 v, float a) {
        float c = cos(a);
        float s = sin(a);
        return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
      }

      void main() {
        vec3 base = vec3(0.72, 0.72, 0.72);
        if (hasBaseMap > 0.5) {
          base = texture2D(baseMap, vUv).rgb;
        }

        vec2 rel = vUv - spotCenter;
        float d = length(rel);
        float feather = max(0.001, softness * radius);
        float spot = 1.0 - smoothstep(radius - feather, radius, d);

        if (hasGobo > 0.5) {
          vec2 guv = rotate2D((vUv - spotCenter) / max(0.001, goboScale), goboRotation) + vec2(0.5);
          float g = texture2D(goboMap, guv).r;
          if (goboInvert > 0.5) g = 1.0 - g;
          spot *= g;
        }

        vec3 lit = base * (ambientFill + (spot * lightGain) * lightColor);
        gl_FragColor = vec4(lit, 1.0);
      }
    `
  });
}

export class LightingRenderer {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.onStatus = callbacks.onStatus;
    this.onProgress = callbacks.onProgress;
    this.cancelRender = false;
    this.lastRenderBase64 = null;
    this.current = {
      baseTexture: null,
      normalTexture: null,
      roughnessTexture: null,
      metalnessTexture: null,
      aoTexture: null,
      displacementTexture: null,
      goboImage: null,
      goboTexture: null
    };

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#0e1218");

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 1.1, 3.2);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance"
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(0, 1.0, 0);
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 7.5;
    this.controls.maxPolarAngle = Math.PI * 0.88;

    this.ambient = new THREE.AmbientLight(0xffffff, 0.02);
    this.scene.add(this.ambient);

    this.spot = new THREE.SpotLight(0xffffff, 1000, 0, THREE.MathUtils.degToRad(42), 0.35, 2.0);
    this.spot.castShadow = true;
    this.spot.position.set(0, 1.2, 3.2);
    this.spot.shadow.mapSize.set(512, 512);
    this.spot.shadow.bias = -0.0001;
    this.spot.shadow.radius = 1;
    this.scene.add(this.spot);
    this.scene.add(this.spot.target);

    this.lightGizmoGroup = new THREE.Group();
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffd8aa })
    );
    this.lightConeGizmo = new THREE.Mesh(
      new THREE.ConeGeometry(0.06, 0.22, 18, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffb35c, transparent: true, opacity: 0.8, wireframe: true })
    );
    this.lightConeGizmo.position.y = 0.14;
    this.lightGizmoGroup.add(bulb);
    this.lightGizmoGroup.add(this.lightConeGizmo);
    this.scene.add(this.lightGizmoGroup);

    this.previewMaterial = buildPreviewMaterial();
    this.hqMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#ffffff"),
      roughness: 0.88,
      metalness: 0.04,
      side: THREE.DoubleSide
    });

    this.wallGeometry = new THREE.PlaneGeometry(3.8, 2.4, 240, 160);
    this.wallGeometry.setAttribute("uv2", new THREE.BufferAttribute(this.wallGeometry.attributes.uv.array, 2));
    this.wall = new THREE.Mesh(this.wallGeometry, this.hqMaterial);
    this.wall.position.set(0, 1.0, 0);
    this.wall.castShadow = true;
    this.wall.receiveShadow = false;
    this.scene.add(this.wall);

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: 0x090b10, roughness: 1.0, metalness: 0.0 })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.22;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(9, 5), new THREE.ShadowMaterial({ opacity: 0.35 }));
    this.backdrop.position.set(0, 1.2, -2.8);
    this.backdrop.receiveShadow = true;
    this.scene.add(this.backdrop);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement);
    this.resize();
    this.animate();
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  animate() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this.animate());
  }

  setControlsLocked(isLocked) {
    this.controls.enabled = !isLocked;
  }

  getCameraState() {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray()
    };
  }

  applyCameraState(cameraState) {
    if (!cameraState) return;
    if (Array.isArray(cameraState.position) && cameraState.position.length === 3) {
      this.camera.position.fromArray(cameraState.position);
    }
    if (Array.isArray(cameraState.target) && cameraState.target.length === 3) {
      this.controls.target.fromArray(cameraState.target);
    }
    this.controls.update();
  }

  async loadBaseTexture(filePath) {
    const texture = await loadTextureFromPath(filePath, { srgb: true });
    if (this.current.baseTexture) this.current.baseTexture.dispose();
    this.current.baseTexture = texture;
    this.previewMaterial.uniforms.baseMap.value = texture;
    this.previewMaterial.uniforms.hasBaseMap.value = 1;
    this.hqMaterial.map = texture;
    this.hqMaterial.needsUpdate = true;
  }

  async loadNormalTexture(filePath) {
    const isExr = filePath.toLowerCase().endsWith(".exr");
    const texture = await loadTextureFromPath(filePath, { exr: isExr, srgb: false });
    if (this.current.normalTexture) this.current.normalTexture.dispose();
    this.current.normalTexture = texture;
    this.hqMaterial.normalMap = texture;
    if (this.hqMaterial.normalScale && typeof this.hqMaterial.normalScale.set === "function") {
      this.hqMaterial.normalScale.set(0.75, 0.75);
    }
    this.hqMaterial.needsUpdate = true;
  }

  clearNormalTexture() {
    if (this.current.normalTexture) {
      this.current.normalTexture.dispose();
      this.current.normalTexture = null;
    }
    this.hqMaterial.normalMap = null;
    this.hqMaterial.needsUpdate = true;
  }

  async loadPbrTexture(filePath, kind) {
    const isExr = filePath.toLowerCase().endsWith(".exr");
    const texture = await loadTextureFromPath(filePath, { exr: isExr, srgb: false });
    if (kind === "roughness") {
      if (this.current.roughnessTexture) this.current.roughnessTexture.dispose();
      this.current.roughnessTexture = texture;
      this.hqMaterial.roughnessMap = texture;
    } else if (kind === "metalness") {
      if (this.current.metalnessTexture) this.current.metalnessTexture.dispose();
      this.current.metalnessTexture = texture;
      this.hqMaterial.metalnessMap = texture;
    } else if (kind === "ao") {
      if (this.current.aoTexture) this.current.aoTexture.dispose();
      this.current.aoTexture = texture;
      this.hqMaterial.aoMap = texture;
      this.hqMaterial.aoMapIntensity = 1.0;
    } else if (kind === "displacement") {
      if (this.current.displacementTexture) this.current.displacementTexture.dispose();
      this.current.displacementTexture = texture;
      this.hqMaterial.displacementMap = texture;
    }
    this.hqMaterial.needsUpdate = true;
  }

  clearPbrTextures() {
    const keys = ["roughnessTexture", "metalnessTexture", "aoTexture", "displacementTexture"];
    keys.forEach((k) => {
      if (this.current[k]) {
        this.current[k].dispose();
        this.current[k] = null;
      }
    });
    this.hqMaterial.roughnessMap = null;
    this.hqMaterial.metalnessMap = null;
    this.hqMaterial.aoMap = null;
    this.hqMaterial.displacementMap = null;
    this.hqMaterial.needsUpdate = true;
  }

  applyTiling(scale, force = true) {
    const s = clamp(finiteOr(scale, 1), 0.25, 8);
    const setTex = (tex) => {
      if (!tex) return;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      if (tex.repeat && typeof tex.repeat.set === "function") {
        tex.repeat.set(s, s);
      }
      tex.needsUpdate = true;
    };
    setTex(this.current.baseTexture);
    setTex(this.current.normalTexture);
    setTex(this.current.roughnessTexture);
    setTex(this.current.metalnessTexture);
    setTex(this.current.aoTexture);
    setTex(this.current.displacementTexture);
    if (force) this.hqMaterial.needsUpdate = true;
  }

  setDisplacementScale(scale) {
    this.hqMaterial.displacementScale = clamp(finiteOr(scale, 0.03), 0, 0.2);
    this.hqMaterial.displacementBias = 0;
    this.hqMaterial.needsUpdate = true;
  }

  disposeProcessedGobo() {
    if (this.current.goboTexture) {
      this.current.goboTexture.dispose();
      this.current.goboTexture = null;
    }
  }

  async loadGoboImage(filePath, goboState) {
    this.current.goboImage = await loadImageFromPath(filePath);
    this.updateGoboTexture(goboState);
  }

  clearGobo() {
    this.current.goboImage = null;
    this.disposeProcessedGobo();
    this.previewMaterial.uniforms.hasGobo.value = 0;
    this.previewMaterial.uniforms.goboMap.value = null;
    this.spot.map = null;
  }

  updateGoboTexture(goboState) {
    if (!this.current.goboImage) {
      this.clearGobo();
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.filter = `blur(${clamp(goboState.focus, 0, 8)}px)`;
    ctx.drawImage(this.current.goboImage, 0, 0, canvas.width, canvas.height);

    if (goboState.invert) {
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const p = id.data;
      for (let i = 0; i < p.length; i += 4) {
        const inv = 255 - p[i];
        p[i] = inv;
        p[i + 1] = inv;
        p[i + 2] = inv;
      }
      ctx.putImageData(id, 0, 0);
    }

    this.disposeProcessedGobo();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.center.set(0.5, 0.5);
    const rep = 1 / clamp(goboState.scale, 0.3, 3.0);
    tex.repeat.set(rep, rep);
    tex.offset.set((1 - rep) * 0.5, (1 - rep) * 0.5);
    tex.rotation = THREE.MathUtils.degToRad(goboState.rotation);
    tex.needsUpdate = true;

    this.current.goboTexture = tex;
    this.spot.map = tex;
    this.previewMaterial.uniforms.hasGobo.value = 1;
    this.previewMaterial.uniforms.goboMap.value = tex;
    this.previewMaterial.uniforms.goboScale.value = goboState.scale;
    this.previewMaterial.uniforms.goboRotation.value = THREE.MathUtils.degToRad(goboState.rotation);
    this.previewMaterial.uniforms.goboInvert.value = goboState.invert ? 1 : 0;
  }

  applyLightingState(state) {
    const azimuth = finiteOr(state.azimuth, 0);
    const elevation = finiteOr(state.elevation, 18);
    const throwDistance = clamp(finiteOr(state.throwDistance, 3.2), 1.2, 8.0);
    const beamAngle = clamp(finiteOr(state.beamAngle, 44), 10, 80);
    const softness = clamp(finiteOr(state.softness, 0.35), 0, 1);
    const ambientFill = clamp(finiteOr(state.ambientFill, 2), 0, 10);
    const lux = clamp(finiteOr(state.lux, 900), 1, 4000);
    const lightHex = state.finalLightColorHex || "#ffd6a8";

    const dir = vectorFromAzEl(azimuth, elevation);
    const targetPos = new THREE.Vector3(0, 1.0, 0);
    const lightPos = targetPos.clone().add(dir.multiplyScalar(throwDistance));
    this.spot.position.copy(lightPos);
    this.spot.target.position.copy(targetPos);
    this.spot.target.updateMatrixWorld();

    const normal = new THREE.Vector3(0, 0, 1);
    const towardLight = lightPos.clone().sub(targetPos).normalize();
    const incidence = Math.max(normal.dot(towardLight), 0.15);
    const candela = (lux * throwDistance * throwDistance) / incidence;
    // Practical calibration for this scene scale/material set to avoid over-bright output.
    const calibrated = candela * 0.03;
    this.spot.intensity = clamp(calibrated, 0.01, 12000);

    this.spot.penumbra = softness;
    this.spot.angle = THREE.MathUtils.degToRad(beamAngle);
    this.spot.distance = 0;
    this.spot.decay = 2;
    this.spot.color.set(lightHex);
    this.ambient.intensity = clamp(ambientFill / 100, 0, 0.1);

    this.lightGizmoGroup.position.copy(lightPos);
    const lookQ = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      targetPos.clone().sub(lightPos).normalize()
    );
    this.lightGizmoGroup.quaternion.copy(lookQ);
    const beamFactor = clamp(beamAngle / 80, 0.15, 1.0);
    this.lightConeGizmo.scale.set(beamFactor, 0.8, beamFactor);
    this.lightConeGizmo.material.color.set(lightHex);

    this.previewMaterial.uniforms.lightColor.value.set(lightHex);
    this.previewMaterial.uniforms.ambientFill.value = clamp(ambientFill / 100, 0, 0.1);
    this.previewMaterial.uniforms.lightGain.value = clamp(lux / 1200, 0.12, 3.5);
    this.previewMaterial.uniforms.softness.value = softness;
    this.previewMaterial.uniforms.radius.value = clamp(
      0.16 + (beamAngle / 80) * 0.26 + throwDistance * 0.02,
      0.18,
      0.56
    );
    this.previewMaterial.uniforms.spotCenter.value.set(
      clamp(0.5 + (azimuth / 85) * 0.28, 0.12, 0.88),
      clamp(0.5 - (elevation / 70) * 0.28, 0.12, 0.88)
    );
  }

  renderHighQualityFallback(state, width, height) {
    const accum = document.createElement("canvas");
    accum.width = width;
    accum.height = height;
    const accumCtx = accum.getContext("2d");
    if (!accumCtx) throw new Error("Fallback render canvas unavailable.");
    const oldSpotMap = this.spot.map;
    const oldCast = this.spot.castShadow;
    const oldShadowEnabled = this.renderer.shadowMap.enabled;
    const oldShadowType = this.renderer.shadowMap.type;
    const oldMaterial = this.wall.material;
    const oldReceiveShadow = this.wall.receiveShadow;
    try {
      this.spot.map = null;
      this.spot.castShadow = true;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.BasicShadowMap;
      this.wall.material = this.previewMaterial;
      this.wall.receiveShadow = false;
      this.applyLightingState(state);
      this.renderer.render(this.scene, this.camera);
      accumCtx.drawImage(this.renderer.domElement, 0, 0, width, height);
      this.lastRenderBase64 = accum.toDataURL("image/png").split(",")[1];
      return { ok: true, base64Png: this.lastRenderBase64, fallback: true };
    } finally {
      this.spot.map = oldSpotMap;
      this.spot.castShadow = oldCast;
      this.renderer.shadowMap.enabled = oldShadowEnabled;
      this.renderer.shadowMap.type = oldShadowType;
      this.wall.material = oldMaterial;
      this.wall.receiveShadow = oldReceiveShadow;
    }
  }

  resetModel() {
    this.scene.remove(this.wall);
    this.wall.geometry.dispose();
    const geom = new THREE.PlaneGeometry(3.8, 2.4, 240, 160);
    geom.setAttribute("uv2", new THREE.BufferAttribute(geom.attributes.uv.array, 2));
    this.wall = new THREE.Mesh(geom, this.hqMaterial);
    this.wall.position.set(0, 1.0, 0);
    this.wall.castShadow = true;
    this.wall.receiveShadow = false;
    this.scene.add(this.wall);
    if (this.current.baseTexture) {
      this.previewMaterial.uniforms.baseMap.value = this.current.baseTexture;
      this.previewMaterial.uniforms.hasBaseMap.value = 1;
      this.hqMaterial.map = this.current.baseTexture;
    }
    if (this.current.normalTexture) {
      this.hqMaterial.normalMap = this.current.normalTexture;
      if (this.hqMaterial.normalScale && typeof this.hqMaterial.normalScale.set === "function") {
        this.hqMaterial.normalScale.set(0.75, 0.75);
      }
    }
    if (this.current.roughnessTexture) this.hqMaterial.roughnessMap = this.current.roughnessTexture;
    if (this.current.metalnessTexture) this.hqMaterial.metalnessMap = this.current.metalnessTexture;
    if (this.current.aoTexture) this.hqMaterial.aoMap = this.current.aoTexture;
    if (this.current.displacementTexture) this.hqMaterial.displacementMap = this.current.displacementTexture;
  }

  async renderHighQuality(state, width, height) {
    if (this.cancelRender === false && this.onProgress) this.onProgress(0);
    this.cancelRender = false;
    this.setControlsLocked(true);

    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const oldPixelRatio = this.renderer.getPixelRatio();
    const oldShadowEnabled = this.renderer.shadowMap.enabled;
    const oldShadowType = this.renderer.shadowMap.type;
    const oldMaterial = this.wall.material;
    const oldSpotCastShadow = this.spot.castShadow;
    const oldMapSize = this.spot.shadow.mapSize.clone();
    const oldRadius = this.spot.shadow.radius;
    const originalLightPos = this.spot.position.clone();
    let canceled = false;

    try {
      this.wall.material = this.hqMaterial;
      this.wall.receiveShadow = true;
      this.spot.castShadow = true;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.spot.shadow.mapSize.set(2048, 2048);
      this.spot.shadow.radius = 6;
      this.spot.shadow.needsUpdate = true;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      ensureTextureMatrix(this.hqMaterial.map);
      ensureTextureMatrix(this.hqMaterial.normalMap);
      ensureTextureMatrix(this.spot.map);
      this.applyLightingState(state);

      const accum = document.createElement("canvas");
      accum.width = width;
      accum.height = height;
      const accumCtx = accum.getContext("2d");
      if (!accumCtx) throw new Error("Render canvas unavailable.");
      accumCtx.fillStyle = "black";
      accumCtx.fillRect(0, 0, width, height);

      const samples = 16;
      const jitter = (0.004 + state.softness * 0.018) * state.throwDistance;
      const progressStep = 100 / samples;
      const startedAt = performance.now();
      const maxMs = 20000;

      for (let i = 0; i < samples; i += 1) {
        if (this.cancelRender) break;
        if (performance.now() - startedAt > maxMs) {
          throw new Error("Render timed out.");
        }
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * jitter;
        this.spot.position.set(
          originalLightPos.x + Math.cos(angle) * r,
          originalLightPos.y + Math.sin(angle) * r,
          originalLightPos.z + Math.sin(angle * 0.5) * r
        );
        this.renderer.render(this.scene, this.camera);
        accumCtx.globalAlpha = 1 / samples;
        accumCtx.drawImage(this.renderer.domElement, 0, 0, width, height);
        if (this.onProgress) this.onProgress(Math.round(progressStep * (i + 1)));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      canceled = this.cancelRender;
      if (!canceled) {
        this.lastRenderBase64 = accum.toDataURL("image/png").split(",")[1];
      }
    } catch (error) {
      try {
        const fallbackResult = this.renderHighQualityFallback(state, width, height);
        this.onStatus("HQ fallback render completed.");
        return fallbackResult;
      } catch (fallbackError) {
        this.onStatus("High quality render failed.");
        return {
          ok: false,
          message: fallbackError?.message || error?.message || "Unexpected render error."
        };
      }
    } finally {
      this.spot.position.copy(originalLightPos);
      this.wall.material = oldMaterial;
      this.wall.receiveShadow = false;
      this.spot.castShadow = oldSpotCastShadow;
      this.spot.shadow.mapSize.copy(oldMapSize);
      this.spot.shadow.radius = oldRadius;
      this.renderer.shadowMap.enabled = oldShadowEnabled;
      this.renderer.shadowMap.type = oldShadowType;
      this.renderer.setPixelRatio(oldPixelRatio);
      this.renderer.setSize(size.x, size.y, false);
      this.applyLightingState(state);
      this.setControlsLocked(false);
      this.cancelRender = false;
    }

    if (canceled) {
      this.onStatus("High quality render canceled.");
      return { ok: false, canceled: true };
    }
    this.onStatus("High quality render completed.");
    return { ok: true, base64Png: this.lastRenderBase64 };
  }

  requestCancelRender() {
    this.cancelRender = true;
  }
}
