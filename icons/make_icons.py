"""
生成扩展图标：蓝色盾牌 + 白色对勾/过滤条。
纯标准库实现（zlib + struct），无需 Pillow。
"""
import zlib, struct, math, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(OUT, exist_ok=True)

BG_TOP = (59, 91, 253)      # #3b5bfd
BG_BOTTOM = (37, 60, 190)   # #253cbe
WHITE = (255, 255, 255)
RED = (220, 38, 38)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def shield_sdf(x, y, s):
    """归一化盾牌形状的近似有符号距离（负为内部）。单位坐标 0..1。"""
    cx = 0.5
    top = 0.22
    bottom = 0.82
    half_top = 0.27

    if y < top or y > bottom:
        return 10.0  # 盾牌上下留空

    t = (y - top) / (bottom - top)

    # 盾牌轮廓：上段近直边，60% 之后按平滑曲线向底部收窄
    if t < 0.60:
        hw = half_top
    else:
        k = (t - 0.60) / 0.40
        # 椭圆式收窄，底部收敛到小尖角
        hw = half_top * math.sqrt(max(0.0, 1.0 - k * k)) * 0.92 + 0.012

    dx = abs(x - cx)
    # 有符号距离：内部为负，外部为正
    return dx - hw


def render(size):
    px = bytearray()
    ss = 4  # 4x 超采样抗锯齿
    for py in range(size):
        row = bytearray()
        for pxi in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (pxi + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size

                    # 圆角矩形底
                    rad = 0.20
                    qx = abs(x - 0.5) - (0.5 - rad)
                    qy = abs(y - 0.5) - (0.5 - rad)
                    outside = math.hypot(max(qx, 0), max(qy, 0)) - rad
                    inside = min(max(qx, qy), 0.0)
                    sdf = outside + inside
                    bg_alpha = 1.0 if sdf <= 0 else 0.0
                    if -0.01 < sdf <= 0:
                        bg_alpha = 0.5

                    if bg_alpha <= 0:
                        continue

                    # 垂直渐变
                    col = lerp(BG_TOP, BG_BOTTOM, y)

                    # 盾牌
                    if shield_sdf(x, y, size) <= 0:
                        col = WHITE

                        # 盾牌内的红色过滤横条（自上而下逐渐收窄，形成"过滤"意象）
                        if 0.42 <= y <= 0.505 and 0.29 <= x <= 0.71:
                            col = RED
                        if 0.555 <= y <= 0.625 and 0.345 <= x <= 0.655:
                            col = RED
                        if 0.665 <= y <= 0.72 and 0.405 <= x <= 0.595:
                            col = RED

                    r += int(col[0] * bg_alpha)
                    g += int(col[1] * bg_alpha)
                    b += int(col[2] * bg_alpha)
                    a += int(255 * bg_alpha)

            n = ss * ss
            row += bytes((r // n, g // n, b // n, a // n))
        px += row
    return bytes(px)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    # 每行前置 filter byte 0
    stride = size * 4
    filtered = bytearray()
    for y in range(size):
        filtered.append(0)
        filtered += raw[y * stride:(y + 1) * stride]
    idat = zlib.compress(bytes(filtered), 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


for s in (16, 32, 48, 128):
    raw = render(s)
    write_png(os.path.join(OUT, f"icon{s}.png"), s, raw)
    print(f"icon{s}.png  {os.path.getsize(os.path.join(OUT, f'icon{s}.png'))} bytes")