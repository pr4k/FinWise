#!/usr/bin/env python3
"""Generate FinWise Home Screen icons without external image dependencies."""

from pathlib import Path
from struct import pack
from zlib import compress, crc32


WEB = Path(__file__).resolve().parents[1] / "web"
BLUE = (37, 99, 201)
WHITE = (255, 255, 255)
DOT = (174, 215, 255)


def pixel(x, y):
    # Match the blue square and white lowercase f of the in-app brand mark.
    stem = .32 <= x <= .43 and .24 <= y <= .77
    top = .32 <= x <= .70 and .24 <= y <= .35
    middle = .25 <= x <= .65 and .43 <= y <= .54
    dot = (x - .72) ** 2 + (y - .72) ** 2 <= .055 ** 2
    return DOT if dot else WHITE if stem or top or middle else BLUE


def chunk(kind, data):
    return pack(">I", len(data)) + kind + data + pack(">I", crc32(kind + data))


def make_icon(size, path):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [pixel((x + dx) / size, (y + dy) / size)
                       for dy in (.125, .375, .625, .875)
                       for dx in (.125, .375, .625, .875)]
            rows.extend(sum(color[channel] for color in samples) // len(samples)
                        for channel in range(3))
    image = (b"\x89PNG\r\n\x1a\n"
             + chunk(b"IHDR", pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
             + chunk(b"IDAT", compress(bytes(rows), level=9))
             + chunk(b"IEND", b""))
    path.write_bytes(image)


for filename, size in (("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)):
    make_icon(size, WEB / filename)
