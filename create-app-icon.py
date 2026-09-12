from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
SCALE = 16
SIZE = 64 * SCALE


def pts(values):
    return [(round(x * SCALE), round(y * SCALE)) for x, y in values]


image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# Full-bleed, high-contrast tile that remains legible at 16–32 px.
draw.rounded_rectangle(
    (2 * SCALE, 2 * SCALE, 62 * SCALE, 62 * SCALE),
    radius=15 * SCALE,
    fill=(24, 62, 49, 255),
    outline=(49, 91, 73, 255),
    width=2 * SCALE,
)

# A quiet ground plane ties the two masses into one city mark.
draw.polygon(pts([(9, 43), (31, 31), (55, 44), (33, 56)]), fill=(45, 83, 67, 255))
draw.line(pts([(12, 44), (33, 54), (52, 44)]), fill=(91, 127, 108, 255), width=1 * SCALE)

# Low waterfront building.
draw.polygon(pts([(11, 29), (22, 23), (33, 29), (22, 35)]), fill=(255, 245, 225, 255))
draw.polygon(pts([(11, 29), (22, 35), (22, 49), (11, 43)]), fill=(205, 222, 211, 255))
draw.polygon(pts([(22, 35), (33, 29), (33, 43), (22, 49)]), fill=(142, 177, 158, 255))

# Taller glass tower.
draw.polygon(pts([(30, 16), (41, 10), (52, 16), (41, 22)]), fill=(238, 242, 232, 255))
draw.polygon(pts([(30, 16), (41, 22), (41, 46), (30, 40)]), fill=(164, 196, 182, 255))
draw.polygon(pts([(41, 22), (52, 16), (52, 40), (41, 46)]), fill=(93, 140, 139, 255))

# Warm roof accent connects the mark to the app's architectural palette.
draw.polygon(pts([(34, 15), (41, 11), (48, 15), (41, 19)]), fill=(221, 131, 77, 255))

# Sparse facade cuts stay visible in the Windows small-icon sizes.
for y in (26, 32, 38):
    draw.line(pts([(44, y), (49, y - 3)]), fill=(202, 225, 218, 210), width=1 * SCALE)
for y in (36, 42):
    draw.line(pts([(14, y), (19, y + 3)]), fill=(244, 248, 239, 180), width=1 * SCALE)

png_path = ROOT / "3Dcity-icon.png"
ico_path = ROOT / "3Dcity-v2.ico"
image.resize((512, 512), Image.Resampling.LANCZOS).save(png_path)
image.save(ico_path, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
print(png_path)
print(ico_path)
