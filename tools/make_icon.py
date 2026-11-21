"""Draws the Pocket Harness launcher icon: a phone whose screen runs a prompt.

The mark is one glyph so it still reads at 48 px in a launcher grid: a phone
outline, with a chevron and a cursor inside it, on the brand teal. Everything is
drawn at 1024 px and downsampled per density, so the strokes stay crisp.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
BRAND_TOP = (31, 111, 92)
BRAND_BOTTOM = (22, 82, 68)
INK = (255, 255, 255)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def background() -> Image.Image:
    canvas = Image.new("RGB", (SIZE, SIZE), BRAND_TOP)
    draw = ImageDraw.Draw(canvas)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        colour = tuple(round(a + (b - a) * t) for a, b in zip(BRAND_TOP, BRAND_BOTTOM))
        draw.line(((0, y), (SIZE, y)), fill=colour)
    return canvas


def glyph() -> Image.Image:
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # The phone body. Drawn as an outline rather than a filled slab so the mark
    # still shows the teal through it, which keeps the icon from reading as a
    # white blob at small sizes.
    draw.rounded_rectangle(
        (322, 202, 702, 822),
        radius=84,
        outline=INK + (255,),
        width=46,
    )

    # The prompt: a chevron and the cursor that follows it.
    draw.line([(432, 424), (528, 512), (432, 600)], fill=INK + (255,), width=46, joint="curve")
    draw.line([(574, 600), (648, 600)], fill=INK + (255,), width=46)
    for point in ((432, 424), (432, 600), (574, 600), (648, 600)):
        draw.ellipse(
            (point[0] - 23, point[1] - 23, point[0] + 23, point[1] + 23),
            fill=INK + (255,),
        )

    # A quieter home indicator, so the body reads as a phone rather than a card.
    draw.ellipse((486, 724, 538, 776), fill=INK + (200,))
    return layer


def compose() -> Image.Image:
    base = background().convert("RGBA")
    base.alpha_composite(glyph())
    base.putalpha(rounded_mask(SIZE, 224))
    return base


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    android = root / "app" / "android" / "app" / "src" / "main" / "res"
    master = compose()

    for folder, px in (
        ("mipmap-mdpi", 48),
        ("mipmap-hdpi", 72),
        ("mipmap-xhdpi", 96),
        ("mipmap-xxhdpi", 144),
        ("mipmap-xxxhdpi", 192),
    ):
        target = android / folder / "ic_launcher.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        master.resize((px, px), Image.LANCZOS).save(target, optimize=True)
        print(f"{target} {px}x{px}")

    store = root / "docs" / "assets" / "icon.png"
    store.parent.mkdir(parents=True, exist_ok=True)
    master.resize((512, 512), Image.LANCZOS).save(store, optimize=True)
    print(f"{store} 512x512")


if __name__ == "__main__":
    main()
