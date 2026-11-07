/**
 * 极简 PNG 解码 + 像素比对（`.verify/_png-lib.mjs`）
 *
 * 只支持 Playwright `page.screenshot()` 产出的形态：8bit / 非隔行 / colorType 2(RGB)|6(RGBA)。
 * 零第三方依赖（`node:zlib` + 手写反滤波），因此不受 `node_modules` 变动影响。
 *
 * 用途：
 *   · `_fe-c-glyph-pixel.mjs` —— VehicleMarker 抽字形前后的**逐字节截图比对**；
 *   · `_fe-c-stoprow-geom.mjs` —— 隐藏/显示图标两帧相减，量出实际着墨 bbox。
 * ⇒ 两个脚本共用**同一份**实现（不要各写一套，否则两处阈值/算法会漂）。
 */
import zlib from "node:zlib";

export function decodePNG(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("不支持隔行 PNG");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`不支持 bitDepth=${bitDepth}`);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`不支持 colorType=${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : zero;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      } else if (f !== 0) throw new Error(`未知 filter ${f}`);
      cur[x] = v;
    }
  }
  return { w, h, bpp, data: out };
}

/** 两帧像素差的外接矩形（设备像素）。`thr` 滤掉抗锯齿噪声 */
export function diffBBox(A, B, thr = 8) {
  if (A.w !== B.w || A.h !== B.h) throw new Error(`尺寸不一致 ${A.w}x${A.h} vs ${B.w}x${B.h}`);
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < A.h; y++) {
    for (let x = 0; x < A.w; x++) {
      const i = (y * A.w + x) * A.bpp;
      let d = false;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(A.data[i + c] - B.data[i + c]) > thr) {
          d = true;
          break;
        }
      }
      if (!d) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/** 两帧是否像素完全一致（逐字节比较 RGBA，零阈值） */
export function pixelsEqual(A, B) {
  return A.w === B.w && A.h === B.h && A.data.equals(B.data);
}

/** 统计与给定背景色不同的像素数（用于证明"截图不是空白"） */
export function countNonBg(img, [r, g, b]) {
  let n = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.bpp;
      if (Math.abs(img.data[i] - r) > 8 || Math.abs(img.data[i + 1] - g) > 8 || Math.abs(img.data[i + 2] - b) > 8) n++;
    }
  }
  return n;
}
