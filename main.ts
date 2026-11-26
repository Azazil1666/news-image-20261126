import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';

// --- PNG ENCODER (stdlib only, pure Node buffer manipulation) ---
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
    }
  }
  return ~crc >>> 0;
}

function writeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePNG(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = writeChunk('IHDR', ihdr);

  const rowSize = width * 4;
  const filtered = Buffer.alloc(height * (rowSize + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (rowSize + 1)] = 0;
    rgba.copy(filtered, y * (rowSize + 1) + 1, y * rowSize, (y + 1) * rowSize);
  }

  const compressed = zlib.deflateSync(filtered, { level: 9 });
  const idatChunk = writeChunk('IDAT', compressed);
  const iendChunk = writeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// --- CANVAS & GRAPHICS ENGINE ---
class Canvas {
  width: number;
  height: number;
  data: Buffer;

  constructor(width: number, height: number) {
    this.width = Math.floor(width);
    this.height = Math.floor(height);
    this.data = Buffer.alloc(this.width * this.height * 4);
    this.fill(246, 243, 235); // warm newsprint background
  }

  fill(r: number, g: number, b: number, a: number = 255) {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    }
  }

  setPixel(x: number, y: number, r: number, g: number, b: number, a: number = 255) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    if (fx < 0 || fx >= this.width || fy < 0 || fy >= this.height) return;
    const idx = (fy * this.width + fx) * 4;
    if (a === 255) {
      this.data[idx] = r;
      this.data[idx + 1] = g;
      this.data[idx + 2] = b;
      this.data[idx + 3] = 255;
    } else {
      const alpha = a / 255;
      const invAlpha = 1 - alpha;
      this.data[idx] = Math.floor(r * alpha + this.data[idx] * invAlpha);
      this.data[idx + 1] = Math.floor(g * alpha + this.data[idx + 1] * invAlpha);
      this.data[idx + 2] = Math.floor(b * alpha + this.data[idx + 2] * invAlpha);
      this.data[idx + 3] = Math.min(255, this.data[idx + 3] + a);
    }
  }

  fillRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number) {
    const x0 = Math.floor(Math.max(0, x));
    const y0 = Math.floor(Math.max(0, y));
    const x1 = Math.floor(Math.min(this.width, x + w));
    const y1 = Math.floor(Math.min(this.height, y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const idx = (py * this.width + px) * 4;
        this.data[idx] = r;
        this.data[idx + 1] = g;
        this.data[idx + 2] = b;
        this.data[idx + 3] = 255;
      }
    }
  }

  drawRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number, lineWidth: number = 1) {
    this.fillRect(x, y, w, lineWidth, r, g, b); // top
    this.fillRect(x, y + h - lineWidth, w, lineWidth, r, g, b); // bottom
    this.fillRect(x, y, lineWidth, h, r, g, b); // left
    this.fillRect(x + w - lineWidth, y, lineWidth, h, r, g, b); // right
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = Math.floor(x0);
    let cy = Math.floor(y0);
    const tx = Math.floor(x1);
    const ty = Math.floor(y1);

    while (true) {
      this.setPixel(cx, cy, r, g, b);
      if (cx === tx && cy === ty) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        cx += sx;
      }
      if (e2 < dx) {
        err += dx;
        cy += sy;
      }
    }
  }

  drawChar(char: string, x: number, y: number, scale: number, r: number, g: number, b: number) {
    const code = char.toUpperCase().charCodeAt(0);
    const glyph = FONT_5X7[code] || FONT_5X7[32];
    for (let py = 0; py < 7; py++) {
      const rowBits = glyph[py] || 0;
      for (let px = 0; px < 5; px++) {
        if ((rowBits & (1 << (4 - px))) !== 0) {
          if (scale === 1) {
            this.setPixel(x + px, y + py, r, g, b);
          } else {
            this.fillRect(x + px * scale, y + py * scale, scale, scale, r, g, b);
          }
        }
      }
    }
  }

  drawText(text: string, x: number, y: number, size: number, r: number, g: number, b: number, maxWidth?: number): number {
    const scale = Math.max(1, Math.floor(size / 7));
    const charWidth = Math.floor(6 * scale);
    const charHeight = Math.floor(8 * scale);
    let cx = Math.floor(x);
    let cy = Math.floor(y);
    let startX = cx;

    const normalized = text
      .replace(/[a-z]/g, c => c.toUpperCase())
      .replace(/—|–/g, '-')
      .replace(/…/g, '...')
      .replace(/·/g, '.');

    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      if (ch === '\n') {
        cx = startX;
        cy += charHeight;
        continue;
      }
      if (maxWidth && cx + charWidth > startX + maxWidth) {
        // Stop or wrap if exceeding maxWidth within single drawText
        break;
      }
      this.drawChar(ch, cx, cy, scale, r, g, b);
      cx += charWidth;
    }
    return cy + charHeight - y;
  }

  drawWrappedText(text: string, x: number, y: number, maxWidth: number, size: number, r: number, g: number, b: number, maxLines: number = 10): number {
    const scale = Math.max(1, Math.floor(size / 7));
    const charWidth = Math.floor(6 * scale);
    const charHeight = Math.floor(8 * scale);
    const charsPerLine = Math.floor(maxWidth / charWidth);
    if (charsPerLine <= 0) return 0;

    const normalized = text
      .replace(/[a-z]/g, c => c.toUpperCase())
      .replace(/—|–/g, '-')
      .replace(/…/g, '...')
      .replace(/·/g, '.');

    const words = normalized.split(' ');
    let lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + ' ' + word).trim().length <= charsPerLine) {
        currentLine = (currentLine + ' ' + word).trim();
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

    let cy = Math.floor(y);
    const linesToDraw = Math.min(lines.length, maxLines);
    for (let i = 0; i < linesToDraw; i++) {
      this.drawText(lines[i], Math.floor(x), cy, size, r, g, b, maxWidth);
      cy += charHeight + 2;
    }
    return cy - y;
  }

  // Strict column text drawing for Also On (FIX 1)
  drawColumnItem(text: string, x: number, y: number, maxWidth: number, size: number, r: number, g: number, b: number): number {
    const scale = Math.max(1, Math.floor(size / 7));
    const charWidth = Math.floor(6 * scale);
    const charHeight = Math.floor(8 * scale);
    const charsPerLine = Math.floor(maxWidth / charWidth);
    if (charsPerLine <= 0) return 0;

    const normalized = text
      .replace(/[a-z]/g, c => c.toUpperCase())
      .replace(/—|–/g, '-')
      .replace(/…/g, '...')
      .replace(/·/g, '.');

    const words = normalized.split(' ');
    let lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + ' ' + word).trim().length <= charsPerLine) {
        currentLine = (currentLine + ' ' + word).trim();
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

    let cy = Math.floor(y);
    // Draw only 1 line per also-on item to keep compact and strictly inside column
    if (lines.length > 0) {
      this.drawText(lines[0], Math.floor(x), cy, size, r, g, b, maxWidth);
    }
    return charHeight;
  }
}

// --- MINI-SCENE DRAWING HELPERS ---
function drawScene(canvas: Canvas, sceneId: number, x: number, y: number, w: number, h: number) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fw = Math.floor(w);
  const fh = Math.floor(h);

  canvas.fillRect(fx, fy, fw, fh, 236, 232, 220);
  canvas.drawRect(fx, fy, fw, fh, 200, 195, 180, 1);

  const setScenePixel = (px: number, py: number, pr: number, pg: number, pb: number) => {
    if (px >= fx + 2 && px < fx + fw - 2 && py >= fy + 2 && py < fy + fh - 2) {
      canvas.setPixel(px, py, pr, pg, pb);
    }
  };

  const fillSceneRect = (rx: number, ry: number, rw: number, rh: number, pr: number, pg: number, pb: number) => {
    for (let py = Math.floor(ry); py < Math.floor(ry + rh); py++) {
      for (let px = Math.floor(rx); px < Math.floor(rx + rw); px++) {
        setScenePixel(px, py, pr, pg, pb);
      }
    }
  };

  switch (sceneId) {
    case 1: // Kim Jong Un tactical nuclear deployment
      fillSceneRect(fx + 8, fy + 12, fw - 16, fh - 20, 50, 50, 50);
      for (let i = 0; i < fw - 16; i += 8) {
        fillSceneRect(fx + 8 + i, fy + 12, 4, 8, 200, 180, 0);
      }
      fillSceneRect(fx + fw / 2 - 8, fy + 25, 16, fh - 35, 180, 40, 40);
      fillSceneRect(fx + fw / 2 - 14, fy + fh - 12, 28, 6, 220, 30, 30);
      break;

    case 2: // Fuel tanker fire Cairo
      fillSceneRect(fx + 5, fy + fh - 22, fw - 10, 18, 80, 80, 80);
      fillSceneRect(fx + 25, fy + fh - 35, 45, 18, 120, 40, 40);
      fillSceneRect(fx + 40, fy + fh - 52, 25, 22, 240, 120, 20);
      fillSceneRect(fx + 45, fy + fh - 66, 15, 18, 255, 200, 0);
      fillSceneRect(fx + 50, fy + fh - 74, 8, 12, 255, 255, 255);
      break;

    case 3: // Nor'easter NYC Thanksgiving
      fillSceneRect(fx + 8, fy + fh - 50, 18, 45, 70, 70, 90);
      fillSceneRect(fx + 30, fy + fh - 70, 22, 65, 60, 60, 80);
      fillSceneRect(fx + 56, fy + fh - 55, 20, 50, 75, 75, 95);
      fillSceneRect(fx + 80, fy + fh - 75, 26, 70, 50, 50, 70);
      for (let rx = fx + 5; rx < fx + fw - 5; rx += 7) {
        for (let ry = fy + 5; ry < fy + fh - 8; ry += 10) {
          canvas.drawLine(rx, ry, rx - 2, ry + 6, 120, 140, 180);
        }
      }
      break;

    case 4: // Lukashenko & Zelensky / suitcase quote
      fillSceneRect(fx + 15, fy + 12, fw - 30, fh - 20, 210, 205, 195);
      fillSceneRect(fx + 30, fy + fh - 30, fw - 60, 16, 90, 90, 90);
      fillSceneRect(fx + fw / 2 - 10, fy + fh - 24, 20, 12, 140, 90, 40);
      break;

    case 5: // Iran Hormuz mines
      fillSceneRect(fx + 5, fy + fh - 28, fw - 10, 24, 40, 90, 140);
      fillSceneRect(fx + 30, fy + fh - 38, 45, 14, 80, 80, 80);
      fillSceneRect(fx + 22, fy + fh - 12, 8, 8, 60, 60, 60);
      canvas.drawLine(fx + 26, fy + fh - 12, fx + 26, fy + fh - 28, 180, 50, 50);
      break;

    case 6: // Russia oil refining low
      fillSceneRect(fx + 20, fy + fh - 60, 10, 50, 100, 100, 100);
      fillSceneRect(fx + 55, fy + fh - 45, 8, 35, 100, 100, 100);
      fillSceneRect(fx + 15, fy + fh - 72, 20, 15, 180, 180, 180);
      fillSceneRect(fx + 12, fy + fh - 85, 26, 15, 200, 200, 200);
      break;

    case 7: // Senegal AFCON title
      fillSceneRect(fx + fw / 2 - 7, fy + 12, 14, 26, 220, 190, 50);
      fillSceneRect(fx + fw / 2 - 12, fy + 36, 24, 6, 220, 190, 50);
      fillSceneRect(fx + fw / 2 - 3, fy + 42, 6, 12, 100, 80, 30);
      fillSceneRect(fx + 8, fy + fh - 12, fw - 16, 8, 50, 140, 60);
      break;

    case 8: // Tinubu Maiduguri peace promise
      fillSceneRect(fx + 12, fy + 20, fw - 24, fh - 30, 190, 180, 160);
      fillSceneRect(fx + fw / 2 - 20, fy + 28, 40, 10, 30, 120, 50);
      fillSceneRect(fx + 25, fy + fh - 20, fw - 50, 10, 90, 90, 90);
      break;

    case 9: // Melania Trump children reunion
      fillSceneRect(fx + 25, fy + fh - 45, 10, 30, 80, 110, 150);
      fillSceneRect(fx + 42, fy + fh - 40, 8, 26, 150, 100, 120);
      fillSceneRect(fx + 58, fy + fh - 45, 10, 30, 90, 130, 90);
      canvas.drawLine(fx + 35, fy + fh - 30, fx + 42, fy + fh - 30, 50, 50, 50);
      canvas.drawLine(fx + 50, fy + fh - 30, fx + 58, fy + fh - 30, 50, 50, 50);
      break;

    case 10: // North Korea orders Switzerland close office
      fillSceneRect(fx + 25, fy + fh - 55, fw - 50, 45, 140, 140, 140);
      fillSceneRect(fx + fw / 2 - 8, fy + fh - 40, 16, 16, 200, 40, 40);
      fillSceneRect(fx + fw / 2 - 5, fy + fh - 35, 10, 6, 255, 255, 255);
      fillSceneRect(fx + fw / 2 - 2, fy + fh - 38, 4, 12, 255, 255, 255);
      break;

    case 11: // Bangladesh garment minimum wage 36%
      fillSceneRect(fx + 25, fy + fh - 55, fw - 50, 40, 70, 110, 140);
      fillSceneRect(fx + fw / 2 - 16, fy + 16, 32, 16, 40, 160, 60);
      break;

    case 12: // India Constitution Day & IIT 6k seats
      fillSceneRect(fx + fw / 2 - 10, fy + 16, 20, fh - 28, 180, 100, 30);
      fillSceneRect(fx + fw / 2 - 16, fy + fh - 16, 32, 8, 30, 80, 160);
      break;
  }
}

// --- WORLD MAP DRAWING HELPER (FIX 2) ---
function drawWorldMap(canvas: Canvas, x: number, y: number, w: number, h: number) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fw = Math.floor(w);
  const fh = Math.floor(h);

  // Background map box
  canvas.fillRect(fx, fy, fw, fh, 240, 236, 226);
  canvas.drawRect(fx, fy, fw, fh, 120, 115, 105, 1);

  // Map title & legend header
  canvas.drawText('GLOBAL DISPATCHES MAP (12 PINNED STORIES)', fx + 8, fy + 6, 8, 40, 40, 40);

  // Draw dotted world outline placeholders (continents)
  // North America
  canvas.fillRect(fx + 40, fy + 25, 60, 35, 215, 210, 200);
  // South America
  canvas.fillRect(fx + 75, fy + 65, 35, 40, 215, 210, 200);
  // Europe
  canvas.fillRect(fx + 160, fy + 22, 45, 30, 215, 210, 200);
  // Africa
  canvas.fillRect(fx + 165, fy + 58, 45, 50, 215, 210, 200);
  // Asia
  canvas.fillRect(fx + 220, fy + 20, 110, 55, 215, 210, 200);
  // Australia
  canvas.fillRect(fx + 300, fy + 75, 40, 30, 215, 210, 200);

  // 12 numbered pins coordinates (approximate pixel locations on map box)
  const pins = [
    { id: 1, px: 280, py: 35, label: '1.NK' },     // North Korea
    { id: 2, px: 195, py: 55, label: '2.CAIRO' },  // Cairo, Egypt
    { id: 3, px: 65, py: 35, label: '3.NYC' },     // New York
    { id: 4, px: 180, py: 28, label: '4.MOSC' },   // Moscow
    { id: 5, px: 245, py: 48, label: '5.HORM' },   // Hormuz / Iran
    { id: 6, px: 260, py: 25, label: '6.RUSS' },   // Russia refining
    { id: 7, px: 145, py: 65, label: '7.SENE' },   // Senegal
    { id: 8, px: 175, py: 68, label: '8.NIG' },    // Nigeria
    { id: 9, px: 172, py: 32, label: '9.KIDS' },   // Ukraine/Kids
    { id: 10, px: 170, py: 28, label: '10.SW' },   // Swiss / NK
    { id: 11, px: 290, py: 52, label: '11.BD' },   // Bangladesh
    { id: 12, px: 275, py: 58, label: '12.IND' },  // India
  ];

  for (const pin of pins) {
    const pabsX = fx + pin.px;
    const pabsY = fy + pin.py;
    canvas.fillRect(pabsX - 3, pabsY - 3, 7, 7, 200, 30, 30);
    canvas.drawText(String(pin.id), pabsX - 2, pabsY - 3, 7, 255, 255, 255);
  }

  // Legend on right half of map box
  const legX = fx + 355;
  let legY = fy + 20;
  for (let i = 0; i < pins.length; i++) {
    const text = `${pins[i].id}:${pins[i].label.split('.')[1] || pins[i].label}`;
    canvas.drawText(text, legX + (i >= 6 ? 65 : 0), legY + (i % 6) * 13, 7, 60, 60, 60);
  }
}

// --- FONT DATA TABLE (5x7 ASCII 32 to 90) ---
const FONT_5X7: number[][] = [];
const RAW_FONT: Record<string, number[]> = {
  ' ': [0,0,0,0,0,0,0],
  'A': [0x4,0xa,0x11,0x1f,0x11,0x11,0x11],
  'B': [0x1e,0x11,0x11,0x1e,0x11,0x11,0x1e],
  'C': [0xe,0x11,0x10,0x10,0x10,0x11,0xe],
  'D': [0x1e,0x11,0x11,0x11,0x11,0x11,0x1e],
  'E': [0x1f,0x10,0x10,0x1e,0x10,0x10,0x1f],
  'F': [0x1f,0x10,0x10,0x1e,0x10,0x10,0x10],
  'G': [0xe,0x11,0x10,0x17,0x11,0x11,0xe],
  'H': [0x11,0x11,0x11,0x1f,0x11,0x11,0x11],
  'I': [0xe,0x4,0x4,0x4,0x4,0x4,0xe],
  'J': [0x7,0x2,0x2,0x2,0x2,0x12,0xc],
  'K': [0x11,0x12,0x14,0x18,0x14,0x12,0x11],
  'L': [0x10,0x10,0x10,0x10,0x10,0x10,0x1f],
  'M': [0x11,0x1b,0x15,0x15,0x11,0x11,0x11],
  'N': [0x11,0x19,0x15,0x13,0x11,0x11,0x11],
  'O': [0xe,0x11,0x11,0x11,0x11,0x11,0xe],
  'P': [0x1e,0x11,0x11,0x1e,0x10,0x10,0x10],
  'Q': [0xe,0x11,0x11,0x11,0x15,0x12,0xd],
  'R': [0x1e,0x11,0x11,0x1e,0x14,0x12,0x11],
  'S': [0xe,0x11,0x10,0xe,0x1,0x11,0xe],
  'T': [0x1f,0x4,0x4,0x4,0x4,0x4,0x4],
  'U': [0x11,0x11,0x11,0x11,0x11,0x11,0xe],
  'V': [0x11,0x11,0x11,0x11,0xa,0xa,0x4],
  'W': [0x11,0x11,0x11,0x15,0x15,0x1b,0x11],
  'X': [0x11,0x11,0xa,0x4,0xa,0x11,0x11],
  'Y': [0x11,0x11,0xa,0x4,0x4,0x4,0x4],
  'Z': [0x1f,0x1,0x2,0x4,0x8,0x10,0x1f],
  '0': [0xe,0x13,0x15,0x19,0x15,0x13,0xe],
  '1': [0x4,0xc,0x4,0x4,0x4,0x4,0xe],
  '2': [0xe,0x11,0x1,0x2,0x4,0x8,0x1f],
  '3': [0x1f,0x1,0x2,0x6,0x1,0x11,0xe],
  '4': [0x2,0x6,0xa,0x12,0x1f,0x2,0x2],
  '5': [0x1f,0x10,0x1e,0x1,0x1,0x11,0xe],
  '6': [0xe,0x10,0x10,0x1e,0x11,0x11,0xe],
  '7': [0x1f,0x1,0x2,0x4,0x8,0x8,0x8],
  '8': [0xe,0x11,0x11,0xe,0x11,0x11,0xe],
  '9': [0xe,0x11,0x11,0xf,0x1,0x1,0xe],
  '.': [0,0,0,0,0,0xc,0xc],
  ',': [0,0,0,0,0,0xc,0x4],
  '-': [0,0,0,0x1f,0,0,0],
  ':': [0,0x4,0,0,0,0x4,0],
  '/': [0x1,0x2,0x4,0x4,0x8,0x10,0x20],
  '+': [0,0x4,0x4,0x1f,0x4,0x4,0],
  '%': [0x18,0x19,0x2,0x4,0x8,0x13,0x3],
  '$': [0x4,0x1f,0x14,0xe,0x5,0x1f,0x4],
  '&': [0xc,0x12,0xc,0xa,0x15,0x12,0xd],
  '\'': [0x4,0x4,0x2,0,0,0,0],
  '"': [0xa,0xa,0,0,0,0,0],
  '?': [0xe,0x11,0x1,0x2,0x4,0,0x4],
  '!': [0x4,0x4,0x4,0x4,0x4,0,0x4],
  '(': [0x2,0x4,0x8,0x8,0x8,0x4,0x2],
  ')': [0x8,0x4,0x2,0x2,0x2,0x4,0x8],
  '_': [0,0,0,0,0,0,0x1f],
  '=': [0,0,0x1f,0,0x1f,0,0],
  '#': [0xa,0xa,0x1f,0xa,0x1f,0xa,0xa],
};

for (let i = 0; i < 256; i++) {
  FONT_5X7[i] = RAW_FONT[' '];
}
for (const key in RAW_FONT) {
  FONT_5X7[key.charCodeAt(0)] = RAW_FONT[key];
  if (key >= 'A' && key <= 'Z') {
    FONT_5X7[key.toLowerCase().charCodeAt(0)] = RAW_FONT[key];
  }
}

// --- MAIN GENERATOR FUNCTION ---
function generateNewspaperPNG(): Buffer {
  const canvas = new Canvas(1024, 1024);

  // --- 1. MASTHEAD & BANNER (y: 0 to 88) ---
  canvas.fillRect(0, 0, 1024, 88, 246, 243, 235);
  canvas.drawLine(0, 4, 1024, 4, 30, 30, 30);
  canvas.drawLine(0, 6, 1024, 6, 30, 30, 30);

  canvas.drawText('THURSDAY, 26 NOVEMBER 2026', 15, 10, 10, 50, 50, 50);
  canvas.drawText('VOL. XXIV NO. 330', 820, 10, 10, 50, 50, 50);

  // FIX 6: Change title to "THE WORLD IN ONE PAGE"
  canvas.drawText('THE WORLD IN ONE PAGE', 190, 24, 28, 10, 10, 10);

  // FIX 6: Top-3 sub-headline line under masthead
  canvas.drawText('TOP 3: 1. KIM JONG UN TACTICAL NUCLEAR DEPLOYMENT | 2. CAIRO TANKER FIRE KILLS 30 | 3. NYC NOR\'EASTER', 95, 54, 9, 140, 30, 30);

  canvas.drawLine(0, 68, 1024, 68, 30, 30, 30);
  canvas.drawLine(0, 70, 1024, 70, 30, 30, 30);

  // Region bars / metadata strip (y: 70 to 88)
  canvas.fillRect(0, 70, 1024, 18, 30, 30, 30);
  canvas.drawText('35 STORIES · 6 REGIONS · ASIA · MIDDLE EAST · NORTH AMERICA · AFRICA · EUROPE · LATIN AMERICA', 110, 74, 9, 255, 255, 255);

  // --- 2. TOP LEAD SECTION (y: 88 to 265) — Top 3 Lead Stories (FIX 8: Densify cards & scenes) ---
  canvas.fillRect(0, 88, 1024, 177, 255, 252, 245);
  canvas.drawRect(0, 88, 1024, 177, 50, 50, 50, 2);

  // Lead 1 (Left: x=10, w=330)
  canvas.fillRect(10, 94, 326, 165, 220, 215, 210, 1);
  drawScene(canvas, 1, 14, 100, 130, 110);
  canvas.drawText('[CONFIRMED] KCNA / CNN', 150, 100, 9, 180, 30, 30);
  // FIX 7: Word-boundary headline wrap
  canvas.drawWrappedText('KIM JONG UN URGES WIDER TACTICAL NUCLEAR DEPLOYMENT', 150, 114, 178, 10, 10, 10, 10, 3);
  canvas.drawWrappedText('Status absolute & inviolable; production capacity systematically expanded across facilities.', 150, 160, 178, 8, 60, 60, 60, 3);

  // Lead 2 (Center: x=346, w=330)
  canvas.fillRect(346, 94, 326, 165, 220, 215, 210, 1);
  drawScene(canvas, 2, 350, 100, 130, 110);
  canvas.drawText('[CONFIRMED] EGYPT HEALTH', 486, 100, 9, 180, 30, 30);
  canvas.drawWrappedText('FUEL TANKER FIRE KILLS 30 ON CAIRO RING ROAD', 486, 114, 178, 10, 10, 10, 10, 3);
  canvas.drawWrappedText('Truck flipped & burst into flames on Giza ring road; 39 ambulances deployed immediately.', 486, 160, 178, 8, 60, 60, 60, 3);

  // Lead 3 (Right: x=682, w=332)
  canvas.fillRect(682, 94, 332, 165, 220, 215, 210, 1);
  drawScene(canvas, 3, 686, 100, 130, 110);
  canvas.drawText('[OFFICIAL] NWS / NYC EM', 822, 100, 9, 30, 90, 180);
  canvas.drawWrappedText('NOR\'EASTER SLAMS NEW YORK ON THANKSGIVING DAY', 822, 114, 184, 10, 10, 10, 10, 3);
  canvas.drawWrappedText('Heavy rain 1-2 in, wind gusts 45-60 mph, coastal flood & flight disruption warnings.', 822, 160, 184, 8, 60, 60, 60, 3);

  // --- 3. PICTURED STORIES GRID (Stories 4 to 12) (y: 265 to 585) ---
  const gridX = [10, 346, 682];
  const gridY = [270, 373, 476];
  const cardW = 326;
  const cardH = 101;

  const picturedStories = [
    { id: 4, src: '[REPORTED] LAMEDITERRANEE', title: 'LUKASHENKO OFFERS ZELENSKY MOSCOW TALKS', body: 'Zelensky replies: "Am I just a suitcase for him?" amid diplomatic push.' },
    { id: 5, src: '[CLAIM] IRAN MARITIME', title: 'SHIPS HIT UNDERWATER MINES IN HORMUZ', body: 'Iran claims mine strikes, warns international shipping to coordinate passage.' },
    { id: 6, src: '[REPORTED] ENERGY WIRE', title: 'RUSSIA REFINING FALLS TO 20-YEAR LOW', body: 'Output drops following synchronized drone strikes across 18 refineries.' },
    { id: 7, src: '[REPORTED] STARLIT DAILY', title: 'SENEGAL WIN BACK 2025 AFCON TITLE', body: 'CAS overturns CAF ruling and formally annuls the disputed final forfeit.' },
    { id: 8, src: '[REPORTED] NIGERIA NEWS', title: 'TINUBU PROMISES PEACE IN NORTHEAST', body: 'Speaking in Maiduguri ahead of key regional elections scheduled for January.' },
    { id: 9, src: '[REPORTED] HUMANITARIAN', title: 'MELANIA TRUMP REUNITES CHILDREN', body: 'Helps facilitate return of nine more Ukrainian and Russian children to families.' },
    { id: 10, src: '[REPORTED] BBC WIRE', title: 'NORTH KOREA EXPELS SWISS DIPLOMAT', body: 'Orders Switzerland to close its diplomatic office in Pyongyang in sanctions row.' },
    { id: 11, src: '[REPORTED] ASIA LABOUR', title: 'BANGLADESH RAISES GARMENT WAGE 36%', body: 'Major pay hike implemented following extensive worker negotiations and protests.' },
    { id: 12, src: '[OFFICIAL] GOVT OF INDIA', title: 'INDIA CELEBRATES CONSTITUTION DAY', body: 'Announces 6,000 new IIT seats in robotics, AI and advanced space technology.' }
  ];

  for (let i = 0; i < picturedStories.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const cx = gridX[col];
    const cy = gridY[row];
    const cw = col === 2 ? 332 : cardW;

    canvas.fillRect(cx, cy, cw, cardH, 255, 253, 248);
    canvas.drawRect(cx, cy, cw, cardH, 200, 195, 185, 1);

    drawScene(canvas, picturedStories[i].id, cx + 5, cy + 5, 85, cardH - 10);

    canvas.drawText(picturedStories[i].src, cx + 96, cy + 6, 8, 120, 40, 40);
    canvas.drawText(picturedStories[i].title, cx + 96, cy + 17, 9, 10, 10, 10, cw - 102);
    canvas.drawWrappedText(picturedStories[i].body, cx + 96, cy + 46, cw - 102, 7, 70, 70, 70, 3);
  }

  // --- 4. WORLD MAP & TIMELINE STRIP (y: 585 to 695) (FIX 2 & FIX 3) ---
  canvas.fillRect(0, 585, 1024, 110, 235, 230, 220);
  canvas.drawRect(0, 585, 1024, 110, 60, 60, 60, 2);

  // World Map on left (x: 10 to 520, w: 510, h: 100)
  drawWorldMap(canvas, 10, 590, 510, 100);

  // UTC Timeline on right (x: 525 to 1014, w: 489, h: 100)
  canvas.fillRect(525, 590, 489, 100, 240, 235, 225);
  canvas.drawRect(525, 590, 489, 100, 130, 125, 115, 1);
  canvas.drawText('26 NOV UTC TIMELINE (NON-TRUNCATED LABELS)', 535, 596, 8, 20, 20, 20);

  // FIX 3: Non-truncated timeline events in 2 rows
  const timelineRow1 = ['00:01 ZELENSKY', '00:06 HORMUZ', '00:06 RUSSIA REF', '00:09 MOSCOW'];
  const timelineRow2 = ['00:20 SENEGAL', '01:21 TINUBU', '08:30 MACYS', '10:00 NYC STORM'];

  let tx = 535;
  for (const ev of timelineRow1) {
    canvas.fillRect(tx, p_clamp(615), 112, 18, 255, 255, 255);
    canvas.drawRect(tx, 615, 112, 18, 160, 160, 160, 1);
    canvas.drawText(ev, tx + 4, 620, 7, 30, 30, 30);
    tx += 116;
  }

  tx = 535;
  for (const ev of timelineRow2) {
    canvas.fillRect(tx, 638, 112, 18, 255, 255, 255);
    canvas.drawRect(tx, 638, 112, 18, 160, 160, 160, 1);
    canvas.drawText(ev, tx + 4, 643, 7, 30, 30, 30);
    tx += 116;
  }

  // --- 5. ALSO ON (Stories 13 to 35) (y: 695 to 840) (FIX 1: Integer math & strict column clipping) ---
  canvas.fillRect(0, 695, 1024, 145, 246, 243, 235);
  canvas.drawRect(0, 695, 1024, 145, 50, 50, 50, 2);

  canvas.drawText('ALSO ON 26 NOVEMBER — WIRE BRIEFS (13–35)', 15, 700, 9, 180, 30, 30);

  const alsoOnItems = [
    '13. VON DER LEYEN: ENERGY CEASEFIRE [REPORTED]',
    '14. KREMLIN ALLEGES ESTONIA DRONE STRIKES [CLAIM]',
    '15. UK: MANDATORY EYE TESTS FOR DRIVERS >70 [REPORTED]',
    '16. GORDON RAMSAY TO HOST TOP GEAR REVIVAL [REPORTED]',
    '17. MOD PREPARES FOR POTENTIAL CONFLICT [REPORTED]',
    '18. RECORD GLOBAL TEMPERATURE STREAK [REPORTED]',
    '19. PERFUME PRICE-FIXING FINES HANDED DOWN [REPORTED]',
    '20. KEMI BADENOCH DEMANDS APOLOGY [REPORTED]',
    '21. CABINET RIFT OVER ED MILIBAND [REPORTED]',
    '22. BBC FACES ANTISEMITISM INQUIRY [REPORTED]',
    '23. GERMANY HOSTS SWIMMING & T20 CRICKET [REPORTED]',
    '24. SPAIN-LINKED WOMEN GROUP CRITICISES CANADA [REPORTED]',
    '25. HONG KONG TIGHTENS EXOTIC PET RULES [REPORTED]',
    '26. BABA APARAJITH RETIRES AT 32 FOR COACHING [REPORTED]',
    '27. MAX VERSTAPPEN: RATHER STAY HOME [REPORTED]',
    '28. DEANDRA DOTTIN WBBL TIMED-OUT RULE [REPORTED]',
    '29. NAGALAND UNITED BEAT SHILLONG 2-1 [REPORTED]',
    '30. INDIAN WOMEN HOCKEY NO. 4 AFTER 4-0 [REPORTED]',
    '31. IPL 2027 AUCTION GETS 1,220 REGISTRATIONS [REPORTED]',
    '32. WORLD CHESS: GUKESH VS SINDAROV [REPORTED]',
    '33. FIVE MEXICANS DETAINED OVER $227M LAB [REPORTED]',
    '34. ECOWAS APPROVES SECURITY FORCE ROADMAP [REPORTED]',
    '35. ECUADOR MINISTER: US TALKS ON OPERATIONS [REPORTED]'
  ];

  // Integer column layout: 3 columns, each width 324px, gap 12px
  const colW = 324;
  const colX = [15, 351, 687];

  for (let i = 0; i < alsoOnItems.length; i++) {
    const col = Math.floor(i / 8);
    const row = i % 8;
    const ax = colX[col];
    const ay = 716 + row * 15;
    canvas.drawColumnItem(alsoOnItems[i], ax, ay, colW, 7, 40, 40, 40);
  }

  // --- 6. THE DAY IN NUMBERS STRIP (y: 840 to 895) (FIX 4: 14 numbers including 1-2 in rain) ---
  canvas.fillRect(0, 840, 1024, 55, 30, 30, 30);
  canvas.drawText('THE DAY IN NUMBERS (14): 30 KILLED (CAIRO) | 45-60 MPH GUSTS | 1-2 IN RAIN (NYC) | 100TH PARADE | 36% WAGE', 15, 848, 8, 255, 220, 100);
  canvas.drawText('3.7M PETS | 1,220 IPL | 6,000 IIT | $227M LAB | 9 REUNITED | 2-1 NAGALAND | 4-0 HOCKEY | 8:30 AM | 23/34 MPH', 15, 868, 8, 200, 200, 200);

  // --- 7. DATE CHECK FOOTER & LEGEND (y: 895 to 1024) (FIX 5: 10 exclusions including Aaron Rodgers) ---
  canvas.fillRect(0, 895, 1024, 129, 220, 215, 205);
  canvas.drawRect(0, 895, 1024, 129, 50, 50, 50, 1);

  canvas.drawText('DATE CHECK (10 EXCLUDED 25 NOV STORIES): UKRAINE ROSNEFT STRIKES; US 301 TARIFFS; SHENZHOU-24;', 12, 902, 7, 100, 30, 30);
  canvas.drawText('US MARKETS ROUT (-2%); HOUTHIS; SUDAN RSF; ANDY TAYLOR; MACY\'S POSTPONED; POUNDLAND; AARON RODGERS.', 12, 917, 7, 100, 30, 30);
  canvas.drawText('CONFIDENCE: [CONFIRMED] VERIFIED WIRES  |  [OFFICIAL] GOV/NWS  |  [REPORTED] MEDIA  |  [CLAIM] UNVERIFIED', 12, 940, 7, 40, 40, 40);
  canvas.drawText('NEWS-IMAGE-20261126 · SESSION 2 FIX/POLISH PASS · NODE 22 STDLIB · 1024X1024 PNG', 12, 957, 7, 80, 80, 80);

  return encodePNG(canvas.width, canvas.height, canvas.data);
}

function p_clamp(v: number): number {
  return Math.floor(v);
}

// --- EXECUTION & VERIFICATION ---
const outDir = process.env.OUTPUT_DIR || './output';
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'entry.png');

const pngBuffer = generateNewspaperPNG();
fs.writeFileSync(outPath, pngBuffer);
console.log(`Successfully generated newspaper front page: ${outPath} (${pngBuffer.length} bytes)`);
