"""
Turns the owner's panel artwork (Hearth's lava frame with a service's header, 1671 by 941) into a
painted panel frame for apps/web/src/components/panels/brands.tsx:

- crops off the "Hearth" title above the frame,
- removes the baked-in logo and name (the panel shows its own), and
- removes the Hearth emblem from the bottom edge (it is drawn separately, so it never stretches).

Needs Pillow (pip install pillow). Run from the repository root:

    python3 scripts/brand-frame.py <image.png> <service> [logo-right-edge]

It writes apps/web/public/brands/<service>-frame.webp. logo-right-edge is where the logo and name
end, in the image's own pixels (default 520).
"""

import sys

from PIL import Image, ImageDraw, ImageFilter

TOP = 68  # The frame starts here; above it is the "Hearth" title.


def soft_mask(size, inset, radius, blur):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (inset, inset, size[0] - inset, size[1] - inset), radius, fill=255
    )
    return mask.filter(ImageFilter.GaussianBlur(blur))


def main():
    src, service = sys.argv[1], sys.argv[2]
    logo_end = int(sys.argv[3]) if len(sys.argv) > 3 else 520
    image = Image.open(src).convert("RGB")
    if image.size != (1671, 941):
        image = image.resize((1671, 941), Image.LANCZOS)
    frame = image.crop((0, TOP, 1671, 941))
    w, h = frame.size

    # The logo and name: covered with the band beside it, mirrored, blurred and darkened, so the
    # panel's own name reads on it.
    x0, y0, x1, y1 = 60, 22, logo_end, 152
    patch = frame.crop((x1, y0, x1 + (x1 - x0), y1)).transpose(Image.FLIP_LEFT_RIGHT)
    patch = patch.filter(ImageFilter.GaussianBlur(10))
    patch = Image.eval(patch, lambda v: int(v * 0.5))
    frame.paste(patch, (x0, y0), soft_mask(patch.size, 8, 24, 10))

    # The bottom emblem: covered with the edge just to its left.
    ex0, ey0, ex1 = 745, 720, 925
    fill = frame.crop((ex0 - 190, ey0, ex1 - 190, h))
    mask = Image.new("L", fill.size, 0)
    ImageDraw.Draw(mask).rectangle((12, 0, fill.size[0] - 12, fill.size[1]), fill=255)
    frame.paste(fill, (ex0, ey0), mask.filter(ImageFilter.GaussianBlur(10)))

    out = f"apps/web/public/brands/{service}-frame.webp"
    frame.save(out, "WEBP", quality=80, method=6)
    print(out, w, h)


if __name__ == "__main__":
    main()
