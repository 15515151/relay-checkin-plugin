#!/usr/bin/env python3
"""验证码识别：多变体预处理 + ddddocr 新旧双模型投票。
从 stdin 读图片二进制，stdout 输出识别结果；无共识时输出空串（调用方换码重试）。"""
import io
import sys
from collections import Counter

import ddddocr
from PIL import Image, ImageFilter, ImageOps

old = ddddocr.DdddOcr(show_ad=False)
beta = ddddocr.DdddOcr(show_ad=False, beta=True)


def classify(ocr, img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return ocr.classification(buf.getvalue())


def variants(im):
    g = im.convert("L")
    return {
        "gray": g,
        "auto": ImageOps.autocontrast(g),
        "med3": g.filter(ImageFilter.MedianFilter(3)),
        "bin140": g.point(lambda p: 255 if p > 140 else 0),
        "bin170": g.point(lambda p: 255 if p > 170 else 0),
        "big2": g.resize((g.width * 2, g.height * 2), Image.LANCZOS),
    }


def main():
    data = sys.stdin.buffer.read()
    im = Image.open(io.BytesIO(data))
    # 每个变体下两个模型的输出；收集 (小写形式, 保留大小写的候选) 对
    candidates = []
    for img in variants(im).values():
        for text in (classify(old, img), classify(beta, img)):
            t = text.strip()
            if t and t.isascii() and t.isalnum():
                candidates.append((t.lower(), t))
    if not candidates:
        return
    # 小写投票，取最高票；票数 >= 3 才认为有共识
    votes = Counter(low for low, _ in candidates)
    low, n = votes.most_common(1)[0]
    if n < 3:
        return
    # 大小写优先采用旧模型风格的候选（旧模型保留大小写，beta 恒小写）
    for _, t in candidates:
        if t.lower() == low and any(c.isupper() for c in t):
            sys.stdout.write(t)
            return
    sys.stdout.write(low.upper())


main()
