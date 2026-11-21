#!/usr/bin/env python3
"""Draw the AgentBridge mark at every size Chrome asks for.

    python3 icons/make_icons.py

One shape, drawn on a 1024 grid and reduced once per size, so 16 px keeps an edge
instead of turning to mush: an ink tile, two piers and one hard deck across them. The product is that deck — the span between an agent and the
browser, with a person standing on it.

Colour is the ink from the popup (#17181A), not a default blue: a toolbar full of
blue squares is how an extension stops being findable.
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent
INK = (23, 24, 26, 255)
PAPER = (255, 255, 255, 255)

S = 1024
TILE_RADIUS = 0.22
SPAN = 0.13
ARCH_X0, ARCH_X1 = 0.285, 0.715
ARCH_TOP = 0.255
PIER_BOTTOM = 0.775
DECK_Y = 0.63
DECK_X0, DECK_X1 = 0.175, 0.825


def master():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * TILE_RADIUS), fill=INK)

    # Deck above, two piers below, one gap narrower than a pier. An arch reads as
    # "A", a centre-cross reads as "H", and a wide gap reads as two separate Ts;
    # this is the arrangement that survives 16 px as one structure.
    deck = (0.135, 0.265, 0.865, 0.365)          # x0, y0, x1, y1
    pier_w = 0.12
    gap = 0.145
    pier_bottom = 0.85
    left = (0.5 - gap / 2 - pier_w, 0.5 - gap / 2)
    right = (0.5 + gap / 2, 0.5 + gap / 2 + pier_w)

    d.rectangle([int(S * deck[0]), int(S * deck[1]), int(S * deck[2]), int(S * deck[3])], fill=PAPER)
    for x0, x1 in (left, right):
        d.rectangle([int(S * x0), int(S * deck[1]), int(S * x1), int(S * pier_bottom)], fill=PAPER)
    return img


def main():
    art = master()
    for size in (128, 48, 16):
        out = HERE / f"icon{size}.png"
        art.resize((size, size), Image.LANCZOS).save(out, optimize=True)
        with Image.open(out) as check:
            check.verify()
        with Image.open(out) as check:
            assert check.size == (size, size), f"{out} came out {check.size}"
        print(f"{out.name}: {size}x{size}, {out.stat().st_size} bytes, PNG verified")


if __name__ == "__main__":
    main()
