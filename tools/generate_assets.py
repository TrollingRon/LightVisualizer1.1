import math
import os
import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "assets"


def write_png(path, width, height, rgb_func):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            r, g, b = rgb_func(x, y, width, height)
            raw.extend(
                (
                    max(0, min(255, int(r))),
                    max(0, min(255, int(g))),
                    max(0, min(255, int(b))),
                )
            )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as f:
        f.write(png)


def base_tex(x, y, width, height):
    gx = x / width
    gy = y / height
    mortar = 28 if (x // 32) % 2 == 0 else 18
    brick_line = y % 32 in (0, 1)
    vert_joint = (x + (16 if (y // 32) % 2 else 0)) % 64 in (0, 1)
    noise = (math.sin(x * 0.37) + math.cos(y * 0.29) + math.sin((x + y) * 0.11)) * 7
    base = 112 + int(20 * gx + 12 * gy + noise)
    r = base + 28
    g = base + 16
    b = base + 8
    if brick_line or vert_joint:
        r = g = b = mortar
    return r, g, b


def height_val(x, y):
    return (
        math.sin(x * 0.12) * 0.5
        + math.cos(y * 0.09) * 0.4
        + math.sin((x + y) * 0.04) * 0.35
    )


def normal_tex(x, y, width, height):
    sx1 = height_val(max(x - 1, 0), y)
    sx2 = height_val(min(x + 1, width - 1), y)
    sy1 = height_val(x, max(y - 1, 0))
    sy2 = height_val(x, min(y + 1, height - 1))
    dx = (sx2 - sx1) * 1.5
    dy = (sy2 - sy1) * 1.5
    nx, ny, nz = -dx, -dy, 1.0
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / length, ny / length, nz / length
    return (nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255


def gobo_tex(x, y, width, height):
    cx, cy = (width - 1) / 2, (height - 1) / 2
    dx, dy = x - cx, y - cy
    r = math.sqrt(dx * dx + dy * dy)
    a = math.atan2(dy, dx)
    spokes = math.sin(a * 8) > 0.2
    ring = 55 < r < 230
    blob = 1 if (spokes and ring) else 0
    soft = max(0.0, min(1.0, 1 - abs(r - 140) / 140))
    v = int((0.15 + 0.85 * (blob * soft)) * 255)
    return v, v, v


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    write_png(str(ROOT / "sample_base_texture.png"), 1024, 1024, base_tex)
    write_png(str(ROOT / "sample_normal_map.png"), 1024, 1024, normal_tex)
    write_png(str(ROOT / "sample_gobo.png"), 512, 512, gobo_tex)
    print(f"Generated sample assets in {ROOT}")
