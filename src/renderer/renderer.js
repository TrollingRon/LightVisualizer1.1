import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

const textureLoader = new THREE.TextureLoader();
const exrLoader = new EXRLoader();
const BASE_TEXTURE_MAX_DIM = 2048;
const DETAIL_TEXTURE_MAX_DIM = 1024;

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

function normalizeBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return null;
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
  const bytes = normalizeBytes(res.bytes);
  if (!bytes) throw new Error("Could not decode image bytes.");
  return loadImageFromBytes(bytes, res.mime || "application/octet-stream");
}

async function loadImageFromBytes(bytes, mime = "application/octet-stream") {
  const blob = new Blob([bytes], { type: mime });
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
  const res = await window.appApi.readBinaryFile(filePath);
  if (!res.ok) throw new Error(res.message || "Could not load file.");
  const bytes = normalizeBytes(res.bytes);
  if (!bytes) throw new Error("Could not decode texture bytes.");
  return loadTextureFromBytes(bytes, { ...options, mime: res.mime || "application/octet-stream" });
}

async function loadTextureFromBytes(bytes, options = {}) {
  const { srgb = false, exr = false, mime = "application/octet-stream", maxDim = 0 } = options;
  if (exr) {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const tex = exrLoader.parse(arrayBuffer);
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  const blob = new Blob([bytes], { type: mime });
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      let source = bitmap;
      if (maxDim > 0) {
        const largest = Math.max(bitmap.width, bitmap.height);
        if (largest > maxDim) {
          const scale = maxDim / largest;
          const targetW = Math.max(1, Math.round(bitmap.width * scale));
          const targetH = Math.max(1, Math.round(bitmap.height * scale));
          const canvas = typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(targetW, targetH)
            : document.createElement("canvas");
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(bitmap, 0, 0, targetW, targetH);
            source = canvas;
          }
        }
      }
      const tex = new THREE.Texture(source);
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.anisotropy = 2;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      if (source !== bitmap && typeof bitmap.close === "function") bitmap.close();
      return tex;
    } catch {
      // Fall through to standard loader path.
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const tex = await textureLoader.loadAsync(url);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 2;
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
      goboInvert: { value: 0.0 },
      hazeEnabled: { value: 1.0 },
      hazeDensity: { value: 0.0 },
      hazeHeight: { value: 0.8 },
      hazeExtinction: { value: 0.0 },
      throwDistance: { value: 3.2 },
      hazeColor: { value: new THREE.Color("#c9d3df") },
      wallHeight: { value: 2.4 }
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
      uniform float hazeEnabled;
      uniform float hazeDensity;
      uniform float hazeHeight;
      uniform float hazeExtinction;
      uniform float throwDistance;
      uniform vec3 hazeColor;
      uniform float wallHeight;

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

        float wallMeters = max(0.001, wallHeight);
        float localHeight = vUv.y * wallMeters;
        float hazeBand = 1.0 - smoothstep(hazeHeight, hazeHeight + 0.9, localHeight);
        float pathLen = throwDistance * hazeBand;
        float transmittance = exp(-hazeEnabled * hazeExtinction * pathLen);
        vec3 direct = (spot * lightGain) * lightColor * transmittance;
        vec3 fogLitTint = mix(hazeColor, lightColor, 0.7);
        vec3 inScatter = fogLitTint * (1.0 - transmittance) * (spot * hazeDensity * 0.45);
        vec3 lit = base * (ambientFill + direct) + inScatter;
        float band = hazeBand;
        float hazeAmt = clamp(hazeEnabled * hazeDensity * (0.12 + 0.20 * spot) * band, 0.0, 1.0);
        vec3 hazed = mix(lit, hazeColor, hazeAmt);
        gl_FragColor = vec4(hazed, 1.0);
      }
    `
  });
}

function buildHazeVolumeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      hazeEnabled: { value: 1.0 },
      hazeDensity: { value: 0.35 },
      hazeHeight: { value: 1.2 },
      hazeColor: { value: new THREE.Color("#c9d3df") },
      lightColor: { value: new THREE.Color("#ffd6a8") },
      volumeWidth: { value: 3.8 },
      volumeHeight: { value: 2.4 },
      volumeDepth: { value: 1.8 },
      edgeFeather: { value: 0.28 },
      phaseG: { value: 0.62 },
      time: { value: 0.0 },
      stepCount: { value: 22 },
      shadowSampleCount: { value: 2 },
      lightPos: { value: new THREE.Vector3(0, 1.2, 3.2) },
      lightDir: { value: new THREE.Vector3(0, -0.1, -1).normalize() },
      beamCos: { value: Math.cos(THREE.MathUtils.degToRad(22)) },
      beamSoftness: { value: 0.08 },
      invModelMatrix: { value: new THREE.Matrix4() },
      hazeModelMatrix: { value: new THREE.Matrix4() },
      shadowMap: { value: null },
      shadowMatrix: { value: new THREE.Matrix4() },
      shadowMapTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      shadowBias: { value: 0.0006 },
      shadowEnabled: { value: 0.0 }
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      uniform float hazeEnabled;
      uniform float hazeDensity;
      uniform float hazeHeight;
      uniform vec3 hazeColor;
      uniform vec3 lightColor;
      uniform float volumeWidth;
      uniform float volumeHeight;
      uniform float volumeDepth;
      uniform float edgeFeather;
      uniform float phaseG;
      uniform float time;
      uniform float stepCount;
      uniform float shadowSampleCount;
      uniform sampler2D shadowMap;
      uniform mat4 shadowMatrix;
      uniform vec2 shadowMapTexel;
      uniform float shadowBias;
      uniform float shadowEnabled;
      uniform vec3 lightPos;
      uniform vec3 lightDir;
      uniform float beamCos;
      uniform float beamSoftness;
      uniform mat4 invModelMatrix;
      uniform mat4 hazeModelMatrix;

      float hash31(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }

      float noise3(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
        float nx00 = mix(n000, n100, f.x);
        float nx10 = mix(n010, n110, f.x);
        float nx01 = mix(n001, n101, f.x);
        float nx11 = mix(n011, n111, f.x);
        float nxy0 = mix(nx00, nx10, f.y);
        float nxy1 = mix(nx01, nx11, f.y);
        return mix(nxy0, nxy1, f.z);
      }

      float fbm(vec3 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i += 1) {
          v += a * noise3(p);
          p = p * 2.01 + vec3(17.1, 9.2, 5.3);
          a *= 0.5;
        }
        return v;
      }

      float phaseHG(float g, float mu) {
        float g2 = g * g;
        float denom = pow(max(1.0 + g2 - 2.0 * g * mu, 0.001), 1.5);
        return (1.0 - g2) / (12.56637 * denom);
      }

      float shadowVisibility(vec3 worldPos) {
        if (shadowEnabled < 0.5) return 1.0;
        vec4 shadowCoord = shadowMatrix * vec4(worldPos, 1.0);
        vec3 proj = shadowCoord.xyz / max(shadowCoord.w, 0.0001);
        if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) {
          return 1.0;
        }
        float depth = proj.z - shadowBias;
        float vis = 0.0;
        const int MAX_SHADOW = 4;
        for (int i = 0; i < MAX_SHADOW; i += 1) {
          if (float(i) >= shadowSampleCount) break;
          vec2 off = vec2(0.0);
          if (i == 0) off = vec2(-1.0, -1.0);
          if (i == 1) off = vec2( 1.0, -1.0);
          if (i == 2) off = vec2(-1.0,  1.0);
          if (i == 3) off = vec2( 1.0,  1.0);
          float shadowDepth = texture2D(shadowMap, proj.xy + off * shadowMapTexel * 1.2).r;
          vis += step(depth, shadowDepth);
        }
        float v = vis / max(shadowSampleCount, 1.0);
        return max(v, 0.25);
      }

      bool rayBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float t0, out float t1) {
        vec3 inv = 1.0 / rd;
        vec3 tA = (bmin - ro) * inv;
        vec3 tB = (bmax - ro) * inv;
        vec3 tMin = min(tA, tB);
        vec3 tMax = max(tA, tB);
        t0 = max(max(tMin.x, tMin.y), tMin.z);
        t1 = min(min(tMax.x, tMax.y), tMax.z);
        return t1 > max(t0, 0.0);
      }

      void main() {
        vec3 ro = (invModelMatrix * vec4(cameraPosition, 1.0)).xyz;
        vec3 rp = (invModelMatrix * vec4(vWorldPos, 1.0)).xyz;
        vec3 rd = normalize(rp - ro);
        vec3 bmin = vec3(-0.5 * volumeWidth, -0.5 * volumeHeight, -0.5 * volumeDepth);
        vec3 bmax = vec3( 0.5 * volumeWidth,  0.5 * volumeHeight,  0.5 * volumeDepth);
        float tNear;
        float tFar;
        if (!rayBox(ro, rd, bmin, bmax, tNear, tFar)) discard;

        tNear = max(tNear, 0.0);
        float len = tFar - tNear;
        if (len <= 0.0001) discard;

        const int MAX_STEPS = 36;
        float dt = len / max(stepCount, 1.0);
        float trans = 1.0;
        vec3 accum = vec3(0.0);
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + time * 3.1) * 43758.5453);
        float tOffset = jitter * dt;

        for (int i = 0; i < MAX_STEPS; i += 1) {
          if (float(i) >= stepCount) break;
          float t = tNear + tOffset + (float(i) + 0.5) * dt;
          if (t > tFar) break;
          vec3 pLocal = ro + rd * t;
          vec3 pWorld = (hazeModelMatrix * vec4(pLocal, 1.0)).xyz;
          vec3 edgeNorm = vec3(
            abs(pLocal.x) / max(0.5 * volumeWidth, 0.001),
            abs(pLocal.y) / max(0.5 * volumeHeight, 0.001),
            abs(pLocal.z) / max(0.5 * volumeDepth, 0.001)
          );
          float fx = 1.0 - smoothstep(1.0 - edgeFeather, 1.0, edgeNorm.x);
          float fy = 1.0 - smoothstep(1.0 - edgeFeather, 1.0, edgeNorm.y);
          float fz = 1.0 - smoothstep(1.0 - edgeFeather, 1.0, edgeNorm.z);
          float edgeMask = fx * fy * fz;
          if (edgeMask <= 0.001) continue;

          float worldY = pWorld.y + 0.2;
          float band = 1.0 - smoothstep(hazeHeight, hazeHeight + 0.9, worldY);
          if (band <= 0.001) continue;

          vec3 lightToSample = pWorld - lightPos;
          float d = max(length(lightToSample), 0.001);
          vec3 lightRay = lightToSample / d;
          float coneRaw = smoothstep(beamCos - beamSoftness, beamCos + beamSoftness, dot(lightRay, lightDir));
          float cone = pow(coneRaw, 1.05);
          float distAtten = 1.0 / (1.0 + 0.22 * d * d);
          vec3 drift = vec3(0.0, time * 0.035, time * 0.02);
          float n = fbm(pWorld * vec3(1.1, 0.85, 1.0) + drift);
          float coneDensity = mix(0.28, 1.0, cone);
          float densityField = band * hazeDensity * coneDensity * edgeMask * mix(0.42, 1.25, n);
          float sigmaS = densityField * 1.35;
          float sigmaT = densityField * 1.55;
          vec3 viewDir = normalize(cameraPosition - pWorld);
          float mu = dot(viewDir, -lightRay);
          float phaseAniso = phaseHG(phaseG, mu);
          float phaseIso = 0.0795775;
          float phase = mix(phaseIso, phaseAniso, 0.3) + phaseIso * 0.85;
          float sideLift = 0.82 + 0.35 * (1.0 - abs(mu));
          phase *= sideLift;
          float shadowVis = shadowVisibility(pWorld);
          float shadowWeight = mix(1.0, shadowVis, 0.2);
          float mediumShadow = exp(-densityField * d * 0.75);
          float beamLit = (0.12 + cone * 4.2) * distAtten;
          vec3 scatter = lightColor * (beamLit * phase * sigmaS * mediumShadow * shadowWeight * hazeEnabled * 38.0);
          scatter += hazeColor * (sigmaS * 0.014 * hazeEnabled * (0.35 + 0.65 * cone));
          accum += trans * scatter * dt;
          trans *= exp(-sigmaT * dt * hazeEnabled * 3.6);
          if (trans < 0.02) break;
        }

        float alpha = clamp((1.0 - trans) * 1.1, 0.0, 0.92);
        vec3 color = accum + hazeColor * (1.0 - trans) * 0.08;
        gl_FragColor = vec4(color, alpha);
      }
    `
  });
}

function applyHazeToStandardMaterial(material) {
  material.customProgramCacheKey = () => "haze-v1";
  material.onBeforeCompile = (shader) => {
    const hazeEnabled = Number.isFinite(material.userData.hazeEnabled) ? material.userData.hazeEnabled : 1.0;
    const hazeDensity = Number.isFinite(material.userData.hazeDensity) ? material.userData.hazeDensity : 0.0;
    const hazeHeight = Number.isFinite(material.userData.hazeHeight) ? material.userData.hazeHeight : 0.8;
    const hazeExtinction = Number.isFinite(material.userData.hazeExtinction) ? material.userData.hazeExtinction : 0.0;
    const throwDistance = Number.isFinite(material.userData.throwDistance) ? material.userData.throwDistance : 3.2;
    shader.uniforms.hazeEnabled = { value: hazeEnabled };
    shader.uniforms.hazeDensity = { value: hazeDensity };
    shader.uniforms.hazeHeight = { value: hazeHeight };
    shader.uniforms.hazeExtinction = { value: hazeExtinction };
    shader.uniforms.throwDistance = { value: throwDistance };
    shader.uniforms.hazeColor = { value: new THREE.Color("#c9d3df") };
    shader.uniforms.hazeWallHeight = { value: 2.4 };
    material.userData.hazeShader = shader;

    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `
      uniform float hazeEnabled;
      uniform float hazeDensity;
      uniform float hazeHeight;
      uniform float hazeExtinction;
      uniform float throwDistance;
      uniform vec3 hazeColor;
      uniform float hazeWallHeight;
      void main() {
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <output_fragment>",
      `
      float wallMeters = max(0.001, hazeWallHeight);
      float uvY = 0.0;
      #ifdef USE_UV
      uvY = vUv.y;
      #endif
      float localHeight = uvY * wallMeters;
      float band = 1.0 - smoothstep(hazeHeight, hazeHeight + 0.9, localHeight);
      float pathLen = throwDistance * band;
      float transmittance = exp(-hazeEnabled * hazeExtinction * pathLen);
      outgoingLight *= transmittance;
      outgoingLight += hazeColor * (1.0 - transmittance) * (hazeDensity * 0.35);
      #include <output_fragment>
      `
    );
  };
}

export class LightingRenderer {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.onStatus = callbacks.onStatus;
    this.onProgress = callbacks.onProgress;
    this.onFps = callbacks.onFps;
    this.cancelRender = false;
    this.lastRenderBytes = null;
    this.frameRequested = false;
    this.animationHandle = null;
    this.renderPaused = false;
    this.hazeAnimating = false;
    this.lastFrameTimeMs = performance.now();
    this.fpsEnabled = false;
    this.frameCounter = 0;
    this.fpsAccumSec = 0;
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
    this.goboWorkCanvas = document.createElement("canvas");
    this.goboWorkCanvas.width = 1024;
    this.goboWorkCanvas.height = 1024;
    this.goboWorkCtx = this.goboWorkCanvas.getContext("2d");
    this.lastGoboKey = "";
    this.textureLimits = {
      base: BASE_TEXTURE_MAX_DIM,
      detail: DETAIL_TEXTURE_MAX_DIM
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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(0, 1.0, 0);
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 7.5;
    this.controls.maxPolarAngle = Math.PI * 0.88;
    this.controls.addEventListener("change", () => this.requestRender());

    this.ambient = new THREE.AmbientLight(0xffffff, 0.02);
    this.scene.add(this.ambient);
    this.houseLight = new THREE.AmbientLight(0xffffff, 0.0);
    this.scene.add(this.houseLight);

    this.spot = new THREE.SpotLight(0xffffff, 1000, 0, THREE.MathUtils.degToRad(42), 0.35, 2.0);
    this.spot.castShadow = true;
    this.spot.position.set(0, 1.2, 3.2);
    this.spot.shadow.mapSize.set(1024, 1024);
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
    this.hazeVolumeMaterial = buildHazeVolumeMaterial();
    this.hqMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#ffffff"),
      roughness: 0.88,
      metalness: 0.04,
      side: THREE.DoubleSide
    });
    applyHazeToStandardMaterial(this.hqMaterial);

    this.wallGeometry = new THREE.PlaneGeometry(3.8, 2.4, 240, 160);
    this.wallGeometry.setAttribute("uv2", new THREE.BufferAttribute(this.wallGeometry.attributes.uv.array, 2));
    this.wall = new THREE.Mesh(this.wallGeometry, this.hqMaterial);
    this.wall.position.set(0, 1.0, 0);
    this.wall.castShadow = true;
    this.wall.receiveShadow = false;
    this.scene.add(this.wall);

    this.hazeVolume = new THREE.Mesh(new THREE.BoxGeometry(3.8, 2.4, 1.8), this.hazeVolumeMaterial);
    this.hazeVolume.position.set(0, 1.0, 0.9);
    this.hazeVolume.renderOrder = 15;
    this.scene.add(this.hazeVolume);

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
    this.requestRender();
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.requestRender();
  }

  shouldAnimateRealtime() {
    return this.hazeAnimating && !this.renderPaused;
  }

  setFpsEnabled(enabled) {
    this.fpsEnabled = Boolean(enabled);
    if (!this.fpsEnabled) {
      this.frameCounter = 0;
      this.fpsAccumSec = 0;
    }
  }

  requestRender() {
    this.frameRequested = true;
    if (this.renderPaused) return;
    if (this.animationHandle) return;
    this.animationHandle = requestAnimationFrame((ts) => this.animate(ts));
  }

  animate(nowMs) {
    this.animationHandle = null;
    if (this.renderPaused) return;
    const dtSec = Math.max(0, (nowMs - this.lastFrameTimeMs) / 1000);
    this.lastFrameTimeMs = nowMs;
    if (this.shouldAnimateRealtime()) {
      const t = this.hazeVolumeMaterial.uniforms.time.value + dtSec;
      this.hazeVolumeMaterial.uniforms.time.value = t;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this.fpsEnabled && typeof this.onFps === "function") {
      this.frameCounter += 1;
      this.fpsAccumSec += dtSec;
      if (this.fpsAccumSec >= 0.25) {
        const fps = this.frameCounter / this.fpsAccumSec;
        this.onFps(fps);
        this.frameCounter = 0;
        this.fpsAccumSec = 0;
      }
    }
    this.frameRequested = false;
    if (this.shouldAnimateRealtime() || this.frameRequested) {
      this.requestRender();
    }
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
    this.requestRender();
  }

  async loadBaseTexture(filePath) {
    const texture = await loadTextureFromPath(filePath, { srgb: true, maxDim: this.textureLimits.base });
    if (this.current.baseTexture) this.current.baseTexture.dispose();
    this.current.baseTexture = texture;
    this.previewMaterial.uniforms.baseMap.value = texture;
    this.previewMaterial.uniforms.hasBaseMap.value = 1;
    this.hqMaterial.map = texture;
    this.hqMaterial.needsUpdate = true;
    this.requestRender();
  }

  async loadNormalTexture(filePath) {
    const isExr = filePath.toLowerCase().endsWith(".exr");
    const texture = await loadTextureFromPath(filePath, {
      exr: isExr,
      srgb: false,
      maxDim: isExr ? 0 : this.textureLimits.detail
    });
    if (this.current.normalTexture) this.current.normalTexture.dispose();
    this.current.normalTexture = texture;
    this.hqMaterial.normalMap = texture;
    if (this.hqMaterial.normalScale && typeof this.hqMaterial.normalScale.set === "function") {
      this.hqMaterial.normalScale.set(0.75, 0.75);
    }
    this.hqMaterial.needsUpdate = true;
    this.requestRender();
  }

  clearNormalTexture() {
    if (this.current.normalTexture) {
      this.current.normalTexture.dispose();
      this.current.normalTexture = null;
    }
    this.hqMaterial.normalMap = null;
    this.hqMaterial.needsUpdate = true;
    this.requestRender();
  }

  clearBaseTexture() {
    if (this.current.baseTexture) {
      this.current.baseTexture.dispose();
      this.current.baseTexture = null;
    }
    this.previewMaterial.uniforms.baseMap.value = null;
    this.previewMaterial.uniforms.hasBaseMap.value = 0;
    this.hqMaterial.map = null;
    this.hqMaterial.needsUpdate = true;
    this.requestRender();
  }

  async loadPbrTexture(filePath, kind) {
    const isExr = filePath.toLowerCase().endsWith(".exr");
    const texture = await loadTextureFromPath(filePath, {
      exr: isExr,
      srgb: false,
      maxDim: isExr ? 0 : this.textureLimits.detail
    });
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
    this.requestRender();
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
    this.requestRender();
  }

  setTextureQuality(level) {
    if (level === "Fast") {
      this.textureLimits.base = 1536;
      this.textureLimits.detail = 768;
      return;
    }
    if (level === "High") {
      this.textureLimits.base = 4096;
      this.textureLimits.detail = 2048;
      return;
    }
    if (level === "Ultra") {
      this.textureLimits.base = 6144;
      this.textureLimits.detail = 3072;
      return;
    }
    this.textureLimits.base = BASE_TEXTURE_MAX_DIM;
    this.textureLimits.detail = DETAIL_TEXTURE_MAX_DIM;
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
    this.requestRender();
  }

  setDisplacementScale(scale) {
    this.hqMaterial.displacementScale = clamp(finiteOr(scale, 0.03), 0, 0.2);
    this.hqMaterial.displacementBias = 0;
    this.hqMaterial.needsUpdate = true;
    this.requestRender();
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
    this.lastGoboKey = "";
    this.disposeProcessedGobo();
    this.previewMaterial.uniforms.hasGobo.value = 0;
    this.previewMaterial.uniforms.goboMap.value = null;
    this.spot.map = null;
    this.requestRender();
  }

  updateGoboTexture(goboState) {
    if (!this.current.goboImage) {
      this.clearGobo();
      return;
    }
    const canvas = this.goboWorkCanvas;
    const ctx = this.goboWorkCtx;
    if (!ctx) return;
    const key = [
      clamp(goboState.scale, 0.3, 3.0).toFixed(3),
      clamp(goboState.rotation, -180, 180).toFixed(2),
      clamp(goboState.focus, 0, 8).toFixed(2),
      goboState.invert ? "1" : "0"
    ].join("|");
    if (key === this.lastGoboKey && this.current.goboTexture) {
      this.requestRender();
      return;
    }
    this.lastGoboKey = key;

    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.filter = `blur(${clamp(goboState.focus, 0, 8)}px)`;
    ctx.save();
    ctx.translate(canvas.width * 0.5, canvas.height * 0.5);
    ctx.rotate(THREE.MathUtils.degToRad(clamp(goboState.rotation, -180, 180)));
    const zoom = clamp(goboState.scale, 0.3, 3.0);
    const drawW = canvas.width / zoom;
    const drawH = canvas.height / zoom;
    ctx.drawImage(this.current.goboImage, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
    ctx.restore();
    ctx.filter = "none";

    if (goboState.invert) {
      ctx.globalCompositeOperation = "difference";
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";
    }

    // Force a circular projection footprint so gobos do not appear as a square card.
    const cx = canvas.width * 0.5;
    const cy = canvas.height * 0.5;
    const rOuter = canvas.width * 0.5;
    const rInner = rOuter * 0.96;
    const edge = ctx.createRadialGradient(cx, cy, rInner, cx, cy, rOuter);
    edge.addColorStop(0, "rgba(255,255,255,1)");
    edge.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";

    this.disposeProcessedGobo();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;

    this.current.goboTexture = tex;
    this.spot.map = tex;
    if (this.spot.shadow) this.spot.shadow.needsUpdate = true;
    if (this.renderer && this.renderer.shadowMap) this.renderer.shadowMap.needsUpdate = true;
    this.previewMaterial.uniforms.hasGobo.value = 1;
    this.previewMaterial.uniforms.goboMap.value = tex;
    this.previewMaterial.uniforms.goboScale.value = 1.0;
    this.previewMaterial.uniforms.goboRotation.value = 0.0;
    this.previewMaterial.uniforms.goboInvert.value = goboState.invert ? 1 : 0;
    this.requestRender();
  }

  applyLightingState(state) {
    const azimuth = finiteOr(state.azimuth, 0);
    const elevation = finiteOr(state.elevation, 18);
    const throwDistance = clamp(finiteOr(state.throwDistance, 3.2), 1.2, 8.0);
    const beamAngle = clamp(finiteOr(state.beamAngle, 44), 10, 80);
    const softness = clamp(finiteOr(state.softness, 0.35), 0, 1);
    const ambientFill = clamp(finiteOr(state.ambientFill, 2), 0, 10);
    const hazeEnabled = state.hazeEnabled === false ? 0 : 1;
    const hazeDensity = clamp(finiteOr(state.hazeDensity, 0), 0, 1);
    const hazeHeight = clamp(finiteOr(state.hazeHeight, 0.8), 0, 2.4);
    const hazeQuality = state.hazeQuality === "Low" || state.hazeQuality === "High" ? state.hazeQuality : "Medium";
    const hazeStepCount = hazeQuality === "Low" ? 14 : hazeQuality === "High" ? 32 : 22;
    const hazeShadowSamples = hazeQuality === "Low" ? 1 : hazeQuality === "High" ? 4 : 2;
    const hazeExtinction = hazeDensity * 0.95;
    const lux = clamp(finiteOr(state.lux, 900), 1, 4000);
    const lightHex = state.finalLightColorHex || "#ffd6a8";
    const houseLightColor = state.houseLightColorHex || "#ffffff";
    const houseLightIntensity = clamp(finiteOr(state.houseLightIntensity, 0), 0, 5);

    const dir = vectorFromAzEl(azimuth, elevation);
    const targetPos = new THREE.Vector3(0, 1.0, 0);
    const lightPos = targetPos.clone().add(dir.multiplyScalar(throwDistance));
    this.spot.position.copy(lightPos);
    this.spot.target.position.copy(targetPos);
    this.spot.target.updateMatrixWorld();
    if (this.spot.shadow && typeof this.spot.shadow.updateMatrices === "function") {
      this.spot.shadow.updateMatrices(this.spot);
    }

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
    this.houseLight.color.set(houseLightColor);
    this.houseLight.intensity = houseLightIntensity;

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
    this.previewMaterial.uniforms.hazeEnabled.value = hazeEnabled;
    this.previewMaterial.uniforms.hazeDensity.value = hazeDensity;
    this.previewMaterial.uniforms.hazeHeight.value = hazeHeight;
    this.previewMaterial.uniforms.hazeExtinction.value = hazeExtinction;
    this.previewMaterial.uniforms.throwDistance.value = throwDistance;

    const beamCos = Math.cos(THREE.MathUtils.degToRad(beamAngle));
    const beamSoftness = THREE.MathUtils.lerp(0.03, 0.16, softness);
    const lightDir = targetPos.clone().sub(lightPos).normalize();
    const phaseG = THREE.MathUtils.lerp(0.32, 0.5, clamp(hazeDensity, 0, 1));
    this.hazeVolumeMaterial.uniforms.hazeEnabled.value = hazeEnabled;
    this.hazeVolumeMaterial.uniforms.hazeDensity.value = hazeDensity;
    this.hazeVolumeMaterial.uniforms.hazeHeight.value = hazeHeight;
    this.hazeVolumeMaterial.uniforms.phaseG.value = phaseG;
    this.hazeVolumeMaterial.uniforms.stepCount.value = hazeStepCount;
    this.hazeVolumeMaterial.uniforms.shadowSampleCount.value = hazeShadowSamples;
    this.hazeVolumeMaterial.uniforms.lightColor.value.set(lightHex);
    this.hazeVolumeMaterial.uniforms.lightPos.value.copy(lightPos);
    this.hazeVolumeMaterial.uniforms.lightDir.value.copy(lightDir);
    this.hazeVolumeMaterial.uniforms.beamCos.value = beamCos;
    this.hazeVolumeMaterial.uniforms.beamSoftness.value = beamSoftness;
    this.hazeVolume.updateMatrixWorld(true);
    this.hazeVolumeMaterial.uniforms.hazeModelMatrix.value.copy(this.hazeVolume.matrixWorld);
    this.hazeVolumeMaterial.uniforms.invModelMatrix.value.copy(this.hazeVolume.matrixWorld).invert();
    if (this.spot.shadow && this.spot.shadow.matrix) {
      this.hazeVolumeMaterial.uniforms.shadowMatrix.value.copy(this.spot.shadow.matrix);
    }
    if (this.spot.shadow && this.spot.shadow.map && this.spot.shadow.map.texture) {
      this.hazeVolumeMaterial.uniforms.shadowMap.value = this.spot.shadow.map.texture;
      const size = this.spot.shadow.mapSize;
      this.hazeVolumeMaterial.uniforms.shadowMapTexel.value.set(1 / Math.max(size.x, 1), 1 / Math.max(size.y, 1));
      this.hazeVolumeMaterial.uniforms.shadowEnabled.value = 1.0;
    } else {
      this.hazeVolumeMaterial.uniforms.shadowEnabled.value = 0.0;
    }

    this.hqMaterial.userData.hazeEnabled = hazeEnabled;
    this.hqMaterial.userData.hazeDensity = hazeDensity;
    this.hqMaterial.userData.hazeHeight = hazeHeight;
    this.hqMaterial.userData.hazeExtinction = hazeExtinction;
    this.hqMaterial.userData.throwDistance = throwDistance;
    const hazeShader = this.hqMaterial.userData.hazeShader;
    if (hazeShader?.uniforms) {
      hazeShader.uniforms.hazeEnabled.value = hazeEnabled;
      hazeShader.uniforms.hazeDensity.value = hazeDensity;
      hazeShader.uniforms.hazeHeight.value = hazeHeight;
      hazeShader.uniforms.hazeExtinction.value = hazeExtinction;
      hazeShader.uniforms.throwDistance.value = throwDistance;
    }
    this.hazeAnimating = hazeEnabled > 0.5 && hazeDensity > 0.001;
    this.requestRender();
  }

  async canvasToPngBytes(canvas) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode PNG.");
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async getLastRenderBytes() {
    return this.lastRenderBytes;
  }

  async renderHighQualityFallback(state, width, height) {
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
      this.lastRenderBytes = await this.canvasToPngBytes(accum);
      return { ok: true, fallback: true };
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
    this.requestRender();
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
    this.renderPaused = true;
    if (this.animationHandle) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }

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
        this.lastRenderBytes = await this.canvasToPngBytes(accum);
      }
    } catch (error) {
      try {
        const fallbackResult = await this.renderHighQualityFallback(state, width, height);
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
      this.lastFrameTimeMs = performance.now();
      this.renderPaused = false;
      this.applyLightingState(state);
      this.setControlsLocked(false);
      this.cancelRender = false;
    }

    if (canceled) {
      this.onStatus("High quality render canceled.");
      return { ok: false, canceled: true };
    }
    this.onStatus("High quality render completed.");
    return { ok: true };
  }

  requestCancelRender() {
    this.cancelRender = true;
  }
}
