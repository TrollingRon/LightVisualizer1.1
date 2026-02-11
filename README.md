# Lighting Texture Previewer

Electron + Three.js desktop tool for theatre designers to preview colored spotlight interaction with a textured wall.

## What It Does
- Shows one textured vertical wall in a dark neutral space.
- Lets you adjust spotlight color/kelvin, lux, direction, softness, throw distance, ambient fill, gels, and gobos.
- Uses an ultra-light real-time preview for responsiveness.
- Generates an on-demand high-quality still render with camera lock and progress.
- Exports high-quality renders to PNG.

## Install Dependencies
```bash
npm install
```

## Run in Dev Mode
```bash
npm run dev
```

## Build Windows EXE (Double-Clickable)
```bash
npm run build:win
```

Build output:
- Installer EXE is generated under `dist/` (NSIS target).
- Install and launch like any normal Windows app.

## Controls
- Orbit camera:
  - Left drag: orbit
  - Mouse wheel: zoom
  - Right drag: pan
- Texture workflow:
  - `Load Base Texture` supports PNG/JPG/JPEG
  - `Load Normal Map (Optional)` supports EXR/PNG/JPG/JPEG
  - `Clear Normal Map`
- Spotlight:
  - Color by HEX/picker or Kelvin slider
  - Intensity in lux (`lx`)
  - Azimuth + elevation
  - Softness and throw distance
  - Ambient fill 0-10%
- Gels:
  - Preset list with Rosco/Lee-style names
  - Custom gel HEX
- Gobos:
  - Load black-and-white mask
  - Scale, rotation, focus, invert
- High-quality render:
  - Resolution list is exactly:
    - `1280×720`
    - `1920×1080`
    - `2560×1440`
  - Click `High Quality Render`
  - Progress bar + cancel
  - Export PNG
- Cog menu (bottom-right):
  - `Reload Code` (app relaunch + state restore)
  - `Reload Textures` (re-reads current file paths)
  - `Reload Model` (resets wall/model material then reapplies textures)
  - `Reload Light` (resets all light/gel/gobo settings)

## Lux Mapping to Three.js SpotLight
- UI uses target illuminance at wall center in lux.
- Three.js `SpotLight.intensity` is treated as luminous intensity.
- Mapping used:
  - `candela = lux * distance^2 / max(cosIncidence, 0.15)`
- This gives a practical theatre-style control where lux remains meaningful as throw direction and distance change.

## Limitations
- Real-time mode is intentionally approximate to maximize speed.
- High-quality mode is still raster/WebGL2 based, not full path tracing.
- EXR normal maps are supported but should be authored as tangent-space normals in linear space.
