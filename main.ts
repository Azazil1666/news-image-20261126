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

  canvas.fillRect(fx, fy, fw, fh, 30, 35, 45);
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
    case 1: // 1 Kyiv night skyline, missile trails arcing down, CHP-4 plant and mall with smoke columns
      fillSceneRect(fx + 5, fy + fh - 35, fw - 10, 30, 40, 40, 50);
      fillSceneRect(fx + 15, fy + fh - 50, 15, 45, 60, 60, 70);
      fillSceneRect(fx + 45, fy + fh - 60, 20, 55, 50, 50, 60);
      fillSceneRect(fx + 20, fy + fh - 70, 6, 20, 120, 120, 120);
      fillSceneRect(fx + 50, fy + fh - 75, 8, 20, 140, 140, 140);
      canvas.drawLine(fx + 10, fy + 5, fx + 25, fy + fh - 50, 255, 200, 50);
      canvas.drawLine(fx + 30, fy + 8, fx + 55, fy + fh - 60, 255, 100, 50);
      break;

    case 2: // 2 Red Sea port at dusk, drone silhouette over a refinery, supertanker, interceptor trails
      fillSceneRect(fx + 5, fy + fh - 25, fw - 10, 22, 30, 60, 90);
      fillSceneRect(fx + 15, fy + fh - 40, 45, 16, 70, 70, 70);
      fillSceneRect(fx + 60, fy + fh - 50, 16, 26, 100, 50, 50);
      fillSceneRect(fx + 35, fy + 20, 14, 3, 20, 20, 20);
      canvas.drawLine(fx + fw - 10, fy + fh - 10, fx + 30, fy + 22, 255, 220, 100);
      break;

    case 3: // 3 Rain-lashed New York street, wind-bent trees, deflated parade balloon, dark storm clouds
      fillSceneRect(fx + 5, fy + 5, fw - 10, 25, 50, 50, 60);
      fillSceneRect(fx + 12, fy + fh - 45, 18, 40, 70, 70, 80);
      fillSceneRect(fx + 50, fy + fh - 60, 22, 55, 60, 60, 70);
      fillSceneRect(fx + 30, fy + fh - 15, 25, 10, 220, 50, 50);
      for (let rx = fx + 6; rx < fx + fw - 6; rx += 8) {
        canvas.drawLine(rx, fy + 20, rx - 4, fy + fh - 10, 150, 170, 200);
      }
      break;

    case 4: // 4 Kuwaiti air-defence station at night, drone silhouette, explosion flash, two empty helmets on a bench
      fillSceneRect(fx + 8, fy + fh - 30, fw - 16, 25, 60, 60, 70);
      fillSceneRect(fx + 20, fy + fh - 20, 24, 6, 90, 90, 90);
      fillSceneRect(fx + 26, fy + fh - 26, 6, 6, 120, 130, 110);
      fillSceneRect(fx + 36, fy + fh - 26, 6, 6, 120, 130, 110);
      fillSceneRect(fx + 50, fy + 18, 12, 3, 30, 30, 30);
      fillSceneRect(fx + 52, fy + 15, 16, 16, 255, 180, 50);
      break;

    case 5: // 5 Trading floor of glowing green screens and rising arrows, oil derrick, gold bar, closed exchange facade
      fillSceneRect(fx + 8, fy + 12, fw - 16, 35, 20, 40, 30);
      fillSceneRect(fx + 12, fy + 16, fw - 24, 8, 40, 200, 80);
      fillSceneRect(fx + 12, fy + 28, fw - 24, 8, 40, 200, 80);
      canvas.drawLine(fx + 15, fy + 40, fx + 35, fy + 20, 50, 255, 50);
      fillSceneRect(fx + 50, fy + fh - 30, 10, 25, 120, 120, 120);
      fillSceneRect(fx + 65, fy + fh - 20, 14, 8, 220, 190, 50);
      break;

    case 6: // 6 Packed football stadium under lights, receiver catching in the end zone, clock showing 0:03
      fillSceneRect(fx + 6, fy + fh - 35, fw - 12, 30, 40, 120, 50);
      fillSceneRect(fx + 10, fy + 8, 8, 6, 255, 255, 200);
      fillSceneRect(fx + fw - 18, fy + 8, 8, 6, 255, 255, 200);
      fillSceneRect(fx + 35, fy + fh - 25, 8, 14, 200, 50, 50);
      fillSceneRect(fx + 50, fy + fh - 28, 8, 16, 50, 50, 200);
      fillSceneRect(fx + fw / 2 - 16, fy + 12, 32, 10, 20, 20, 20);
      break;

    case 7: // 7 Field clinic in Congolese forest, workers in white protective suits, red-cross tent
      fillSceneRect(fx + 6, fy + fh - 35, fw - 12, 30, 40, 80, 40);
      fillSceneRect(fx + 20, fy + 15, fw - 40, fh - 25, 240, 240, 240);
      fillSceneRect(fx + fw / 2 - 6, fy + 22, 12, 12, 220, 40, 40);
      fillSceneRect(fx + 30, fy + fh - 20, 6, 14, 255, 255, 255);
      fillSceneRect(fx + 45, fy + fh - 20, 6, 14, 255, 255, 255);
      break;

    case 8: // 8 White cliffs of Dover, airport arrivals board, near-empty passport queue, downward arrow chart
      fillSceneRect(fx + 6, fy + fh - 30, fw - 12, 25, 230, 230, 230);
      fillSceneRect(fx + 12, fy + 12, 30, 18, 30, 30, 30);
      canvas.drawLine(fx + 50, fy + 15, fx + 72, fy + 35, 200, 40, 40);
      break;

    case 9: // 9 Floodlit European stadium, celebrating players in red and black, scoreboard CELTA 1-2 BOURNEMOUTH
      fillSceneRect(fx + 6, fy + fh - 30, fw - 12, 25, 30, 90, 40);
      fillSceneRect(fx + fw / 2 - 25, fy + 10, 50, 14, 20, 20, 20);
      fillSceneRect(fx + 30, fy + fh - 22, 7, 14, 180, 30, 30);
      fillSceneRect(fx + 42, fy + fh - 24, 7, 16, 180, 30, 30);
      fillSceneRect(fx + 54, fy + fh - 22, 7, 14, 30, 30, 30);
      break;

    case 10: // 10 Flooded mine mouth in jungle, rescue workers with headlamps, heavy rain, rope line
      fillSceneRect(fx + 6, fy + fh - 35, fw - 12, 30, 50, 70, 50);
      fillSceneRect(fx + 25, fy + fh - 25, 20, 18, 20, 20, 20);
      fillSceneRect(fx + 55, fy + fh - 22, 6, 14, 200, 160, 40);
      fillSceneRect(fx + 55, fy + fh - 24, 4, 3, 255, 255, 255);
      for (let rx = fx + 8; rx < fx + fw - 8; rx += 7) {
        canvas.drawLine(rx, fy + 10, rx - 3, fy + fh - 10, 140, 160, 190);
      }
      break;

    case 11: // 11 Garment workers marching in Dhaka, factory gates, placards, sewing machines
      fillSceneRect(fx + 10, fy + fh - 35, fw - 20, 30, 100, 100, 110);
      fillSceneRect(fx + 22, fy + fh - 25, 8, 16, 200, 50, 50);
      fillSceneRect(fx + 38, fy + fh - 27, 8, 18, 50, 150, 200);
      fillSceneRect(fx + 34, fy + fh - 38, 16, 10, 240, 240, 240);
      break;

    case 12: // 12 Strait of Hormuz at dawn, supertanker, mine below the surface, distant explosion plume
      fillSceneRect(fx + 5, fy + fh - 25, fw - 10, 22, 40, 80, 120);
      fillSceneRect(fx + 20, fy + fh - 40, 42, 14, 70, 70, 70);
      fillSceneRect(fx + 30, fy + fh - 12, 8, 8, 50, 50, 50);
      fillSceneRect(fx + 60, fy + fh - 45, 12, 16, 255, 140, 40);
      break;
  }
}

// --- WORLD MAP DRAWING HELPER ---
function drawWorldMap(canvas: Canvas, x: number, y: number, w: number, h: number) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fw = Math.floor(w);
  const fh = Math.floor(h);

  canvas.fillRect(fx, fy, fw, fh, 240, 236, 226);
  canvas.drawRect(fx, fy, fw, fh, 120, 115, 105, 1);

  canvas.drawText('GLOBAL DISPATCHES MAP, 12 PINNED STORIES', fx + 8, fy + 6, 8, 40, 40, 40);

  canvas.fillRect(fx + 30, fy + 22, 50, 32, 215, 210, 200);
  canvas.fillRect(fx + 60, fy + 58, 30, 35, 215, 210, 200);
  canvas.fillRect(fx + 145, fy + 20, 38, 25, 215, 210, 200);
  canvas.fillRect(fx + 150, fy + 50, 38, 42, 215, 210, 200);
  canvas.fillRect(fx + 195, fy + 18, 95, 50, 215, 210, 200);
  canvas.fillRect(fx + 265, fy + 68, 32, 25, 215, 210, 200);

  const pins = [
    { id: 1, px: 168, py: 24, label: 'KYIV' },
    { id: 2, px: 175, py: 52, label: 'JIZAN' },
    { id: 3, px: 50, py: 30, label: 'NEW YORK' },
    { id: 4, px: 182, py: 48, label: 'KUWAIT CITY' },
    { id: 5, px: 138, py: 20, label: 'LONDON' },
    { id: 6, px: 40, py: 28, label: 'DETROIT' },
    { id: 7, px: 160, py: 72, label: 'KINSHASA' },
    { id: 8, px: 150, py: 32, label: 'BOURNEMOUTH' },
    { id: 9, px: 250, py: 62, label: 'BOGOR' },
    { id: 10, px: 235, py: 38, label: 'DHAKA' },
    { id: 11, px: 210, py: 50, label: 'HORMUZ' },
    { id: 12, px: 275, py: 32, label: 'TOKYO' },
  ];

  for (const pin of pins) {
    const pabsX = fx + pin.px;
    const pabsY = fy + pin.py;
    canvas.fillRect(pabsX - 3, pabsY - 3, 7, 7, 200, 30, 30);
    canvas.drawText(String(pin.id), pabsX - 2, pabsY - 3, 7, 255, 255, 255);
  }

  const legX1 = fx + 305;
  const legX2 = fx + 405;
  let legY = fy + 18;
  for (let i = 0; i < pins.length; i++) {
    const text = `${pins[i].id}. ${pins[i].label}`;
    const colX = i < 6 ? legX1 : legX2;
    const rowY = legY + (i % 6) * 13;
    canvas.drawText(text, colX, rowY, 7, 50, 50, 50);
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
  canvas.drawText('TOP 3: 1. HYPERSONIC FIRE OVER KYIV | 2. GULF IN FLAMES | 3. THANKSGIVING NOR EASTER', 95, 54, 9, 140, 30, 30);

  canvas.drawLine(0, 68, 1024, 68, 30, 30, 30);
  canvas.drawLine(0, 70, 1024, 70, 30, 30, 30);

  // Region bars / metadata strip (y: 70 to 88)
  canvas.fillRect(0, 70, 1024, 18, 30, 30, 30);
  canvas.drawText('35 STORIES - 6 REGIONS - EUROPE - MIDDLE EAST - NORTH AMERICA - AFRICA - ASIA - GLOBAL', 110, 74, 9, 255, 255, 255);

  // --- 2. TOP LEAD SECTION (y: 88 to 265) — Top 3 Lead Stories (FIX 8: Densify cards & scenes) ---
  canvas.fillRect(0, 88, 1024, 177, 255, 252, 245);
  canvas.drawRect(0, 88, 1024, 177, 50, 50, 50, 2);

  // Lead 1 (Left: x=10, w=330)
  canvas.fillRect(10, 94, 326, 165, 220, 215, 210, 1);
  drawScene(canvas, 1, 14, 100, 130, 135);
  canvas.drawText('[CONFIRMED] REUTERS / AP', 150, 100, 9, 180, 30, 30);
  canvas.drawWrappedText('HYPERSONIC FIRE OVER KYIV', 150, 114, 178, 10, 10, 10, 10, 3);
  canvas.drawWrappedText('Russia fires Zircon and S-400 missiles at Kyiv CHP-4 plant and Prospekt mall, 7 wounded. 113 drones launched. Ukraine hits back in Russia.', 150, 160, 178, 8, 60, 60, 60, 5);
  canvas.drawText('7 WOUNDED - 113 DRONES - 100,000+ T GRAIN', 14, 240, 8, 180, 30, 30);

  // Lead 2 (Center: x=346, w=330)
  canvas.fillRect(346, 94, 326, 165, 220, 215, 210, 1);
  drawScene(canvas, 2, 350, 100, 130, 135);
  canvas.drawText('[CONFIRMED] REUTERS / AP', 486, 100, 9, 180, 30, 30);
  canvas.drawWrappedText('GULF IN FLAMES', 486, 114, 178, 10, 10, 10, 10, 3);
  canvas.drawWrappedText('Houthis strike Saudi port of Jizan. Coalition stops a drone near Jeddah and missiles over Riyadh. A drone kills 2 Italians in Kuwait.', 486, 160, 178, 8, 60, 60, 60, 5);
  canvas.drawText('JIZAN HIT - 2 MISSILES DOWN - 2 KILLED', 350, 240, 8, 180, 30, 30);

  // Lead 3 (Right: x=682, w=332)
  canvas.fillRect(682, 94, 332, 165, 220, 215, 210, 1);
  drawScene(canvas, 3, 686, 100, 130, 135);
  canvas.drawText('[CONFIRMED] WSJ / NWS', 822, 100, 9, 30, 90, 180);
  canvas.drawWrappedText('THANKSGIVING UNDER WATER AND WIND', 822, 114, 184, 10, 10, 10, 10, 3);
  canvas.drawWrappedText('Nor easter cuts power for 250,000 plus on the US East Coast. Gusts 65 mph in New York. 350 flights cancelled. Macy parade moves to Sat.', 822, 160, 184, 8, 60, 60, 60, 5);
  canvas.drawText('250,000+ NO POWER - 65 MPH - 350 FLIGHTS', 686, 240, 8, 30, 90, 180);

  // --- 3. PICTURED STORIES GRID (Stories 4 to 12) (y: 265 to 585) ---
  const gridX = [10, 346, 682];
  const gridY = [270, 373, 476];
  const cardW = 326;
  const cardH = 101;

  const picturedStories = [
    { id: 4, src: '[CONFIRMED] REUTERS/CNN', title: 'TWO ITALIANS KILLED IN KUWAIT', body: 'Iranian drone hits a Kuwait air-defence station, killing 2 Rheinmetall Italia technicians. Tehran denies any role.' },
    { id: 5, src: '[CONFIRMED] REUTERS', title: 'THE BOUNCE AFTER THE ROUT', body: 'US markets shut for Thanksgiving. Wednesday Dow 50,182.95, plus 0.33 percent. Nikkei up 0.86, STOXX up 1.75, Brent 96.53.' },
    { id: 6, src: '[CONFIRMED] REUTERS/AP', title: 'THREE SECONDS TO GLORY', body: 'Williams hits Odunze with three seconds left as Chicago erases an 11 point deficit in Detroit. Bears 39-35 Lions, first in the NFC North.' },
    { id: 7, src: '[CONFIRMED] REUTERS/DRC', title: 'EBOLA PASSES 12,000 CASES', body: 'DR Congo outbreak reaches 12,021 cases and 5,904 deaths, the second largest on record. Containment struggles amid insecurity.' },
    { id: 8, src: '[OFFICIAL] ONS/REUTERS', title: 'BRITAIN GREAT SLOWDOWN', body: 'UK net migration falls to 77,000 in the year to June 2026, down from 204,000. Lowest since 1997 outside the pandemic years.' },
    { id: 9, src: '[CONFIRMED] UEFA/AP', title: 'FIVE IN A ROW FOR BOURNEMOUTH', body: 'Ten-man Bournemouth beat Celta Vigo 2-1, first English club to win its opening five European matches. Club record 10th straight win.' },
    { id: 10, src: '[CONFIRMED] AP', title: 'BURIED ALIVE IN BOGOR', body: 'Illegal gold-mine flood toll update: 13 dead, 13 missing about 100 metres underground. The flood itself was late Monday 23 Nov.' },
    { id: 11, src: '[REPORTED] REUTERS', title: 'DHAKA WAGE REVOLT', body: 'Bangladesh 36 percent garment minimum-wage rise misses workers demands and sparks fresh street protests in Dhaka after months of unrest.' },
    { id: 12, src: '[CLAIM] REUTERS/IRGC', title: 'MINES IN THE STRAIT', body: 'IRGC claims a supertanker with 2 million plus barrels was hit by a mine near Khasab in the Strait of Hormuz. Britain reports a blast.' }
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
    canvas.drawWrappedText(picturedStories[i].title, cx + 96, cy + 17, cw - 102, 9, 10, 10, 10, 2);
    canvas.drawWrappedText(picturedStories[i].body, cx + 96, cy + 44, cw - 102, 7, 70, 70, 70, 4);
  }

  // --- 4. WORLD MAP & TIMELINE STRIP (y: 585 to 695) (FIX 2 & FIX 3) ---
  canvas.fillRect(0, 585, 1024, 110, 235, 230, 220);
  canvas.drawRect(0, 585, 1024, 110, 60, 60, 60, 2);

  // World Map on left (x: 10 to 520, w: 510, h: 100)
  drawWorldMap(canvas, 10, 590, 510, 100);

  // UTC Timeline on right (x: 525 to 1014, w: 489, h: 100)
  canvas.fillRect(525, 590, 489, 100, 240, 235, 225);
  canvas.drawRect(525, 590, 489, 100, 130, 125, 115, 1);
  canvas.drawText('26 NOV UTC TIMELINE', 535, 596, 8, 20, 20, 20);

  const timelineRow1 = ['00:18 SIEMENS', '01:32 KYIV', '01:38 PDVSA', 'AM ONS 77,000', '14:00 NO POWER'];
  const timelineRow2 = ['17:13 ELEX DELAY', 'EVE BOURNEMOUTH', '20:01 COPERNICUS', '21:38 BEARS 39-35'];

  let tx = 532;
  for (const ev of timelineRow1) {
    canvas.fillRect(tx, p_clamp(615), 94, 18, 255, 255, 255);
    canvas.drawRect(tx, 615, 94, 18, 160, 160, 160, 1);
    canvas.drawText(ev, tx + 4, 620, 7, 30, 30, 30);
    tx += 97;
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
    '13. GUINEA-BISSAU DELAYS VOTE TO NOV 2028 [CONFIRMED]',
    '14. GERMANY ARRESTS 2 OVER SYNAGOGUE PLOT [CONFIRMED]',
    '15. GAZA STRIKES KILL 9, 3RD NIGHT IN ROW [REPORTED]',
    '16. CAIRO TOLL NOW 31 DEAD, DRIVER HELD [CONFIRMED]',
    '17. VENEZUELA IN TALKS TO CLEAR 4.2BN DEBT [REPORTED]',
    '18. VENEZUELA: SIEMENS DEAL, 2BN ENI PLEDGE [REPORTED]',
    '19. TAIWAN JAILS EX-SAILOR 6 YRS FOR SPYING [CONFIRMED]',
    '20. DE COS PICKED AS NEXT ECB PRESIDENT [REPORTED]',
    '21. ALTRIA EYES IMPERIAL BRANDS, SHRS UP 17.6% [CONFIRMED]',
    '22. BOE: HYPERSCALER EXPOSURE TOPS 4TN [OFFICIAL]',
    '23. SIX DAYS ABOVE 2C, A FIRST, PEAK 2.24C [REPORTED]',
    '24. NORSE ATLANTIC HALTS FLIGHTS, WARNS [REPORTED]',
    '25. BANGKOK REFINERY FIRE INJURES NINE [REPORTED]',
    '26. IRAQ CLOSES 2 KURDISTAN CROSSINGS [REPORTED]',
    '27. US URGES CITIZENS TO LEAVE IRAN [REPORTED]',
    '28. PHILIPPINES COMMISSIONS 3 PATROL SHIPS [REPORTED]',
    '29. GAO: US MUNITIONS TAKE YEARS TO REBUILD [REPORTED]',
    '30. FINCEN CONFIRMS INTERNAL CYBER BREACH [REPORTED]',
    '31. 1PASSWORD DEV ENVIRONMENT BREACHED [REPORTED]',
    '32. KENYAN CULT LEADER GUILTY OF TERROR [REPORTED]',
    '33. MUSK PLEDGES SPACEX SHARES FOR KIDS [REPORTED]',
    '34. BANK OF KOREA RAISES RATE TO 3.25% [REPORTED]',
    '35. KUSHNER CONFIRMS DIRECT IRAN TALKS [REPORTED]'
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
  canvas.drawText('THE DAY IN NUMBERS (14): 7 WOUNDED KYIV | 113 DRONES | 100,000+ T GRAIN | 250,000+ NO POWER | 65 MPH GUSTS | 350 FLIGHTS | 12,021 CASES 5,904 DEATHS', 15, 848, 8, 255, 220, 100);
  canvas.drawText('77,000 UK MIGRATION | 39-35 BEARS WIN | 5 BOURNEMOUTH WINS | 13 DEAD 13 MISSING BOGOR | 2 ITALIANS KILLED | 96.53 BRENT | 57,499.16 NIKKEI', 15, 868, 8, 200, 200, 200);

  // --- 7. DATE CHECK FOOTER & LEGEND (y: 895 to 1024) (FIX 5: 10 exclusions including Aaron Rodgers) ---
  canvas.fillRect(0, 895, 1024, 129, 220, 215, 205);
  canvas.drawRect(0, 895, 1024, 129, 50, 50, 50, 1);

  canvas.drawText('DATE CHECK (18 EXCLUDED, NOT 26 NOV NEWS):', 12, 902, 7, 100, 30, 30);
  canvas.drawText('KIM NUCLEAR ORDER 25 NOV; CAIRO TANKER FIRE 25 NOV; SHENZHOU-24 25 NOV; USTR 301 TARIFFS 25 NOV; SAMARA STRIKES 25 NOV;', 12, 914, 7, 100, 30, 30);
  canvas.drawText('RAMS BEAT PACKERS WED 25 NOV; IOWA AMMO BLAST WED 25 NOV; WALL ST WED REVERSAL 25 NOV; COP31 COLLAPSE 21-22 NOV;', 12, 926, 7, 100, 30, 30);
  canvas.drawText('SOLOMON TREATY SIGNED WED 25 NOV; NETANYAHU CASE 4000 WED 25 NOV; MAMDANI RENT FREEZE WED 25 NOV; MYANMAR ICJ WED 25 NOV;', 12, 938, 7, 100, 30, 30);
  canvas.drawText('N KOREA EXPELS SWISS DIPLOMAT 25 NOV; MACYS MOVE DECIDED WED 25 NOV; SUDAN RSF STRIKES 24 NOV; POUNDLAND 25 NOV; RAS TANURA CLAIM 25 NOV.', 12, 950, 7, 100, 30, 30);
  canvas.drawText('CONFIDENCE: [CONFIRMED] VERIFIED WIRES  |  [OFFICIAL] GOV/NWS  |  [REPORTED] MEDIA  |  [CLAIM] UNVERIFIED', 12, 968, 7, 40, 40, 40);
  canvas.drawText('NEWS-IMAGE-20261126 - RESUBMIT FULL-DAY RESEARCH - NODE 22 STDLIB - 1024X1024 PNG', 12, 985, 7, 80, 80, 80);

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
