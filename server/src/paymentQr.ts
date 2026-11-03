/**
 * The payment QR code: checking an uploaded image and reading it back.
 *
 * Only a JPEG is stored, because that is what the PDF writer can place on a
 * page unchanged (DCTDecode), so no image library is needed on the server.
 * The screen turns whatever the office picks (PNG or JPEG) into a JPEG before
 * sending it; this checks what arrives anyway, since the screen is not the only
 * way to call the route.
 *
 * Checked: that it is a JPEG, that it is 8-bit grey or RGB (a CMYK file would
 * print in the wrong colours), that it is square to within a tenth, and that
 * it is big enough to print sharp at 3 cm (300 pixels a side), and not so big
 * that it bloats every document that carries it.
 */

import type { Queryable } from './pg';
import { badRequest } from './http';

export const QR_MIN_PX = 300;
export const QR_MAX_PX = 1600;
export const QR_MAX_BYTES = 400_000;

export interface JpegInfo {
  readonly widthPx: number;
  readonly heightPx: number;
  /** 1 for grey, 3 for colour. */
  readonly components: number;
}

const u16 = (b: Buffer, at: number): number => (b[at] << 8) | b[at + 1];

/** Reads a JPEG's size and colour model from its frame header, or says why it is not one. */
export function readJpeg(bytes: Buffer): JpegInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw badRequest('That is not a JPEG image. Use a PNG or JPEG of the QR code.');
  }
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    // Markers with no length: SOI, EOI, RSTn, TEM.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = u16(bytes, at + 2);
    // Start of frame: baseline, extended, progressive.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (at + 10 > bytes.length) break;
      const precision = bytes[at + 4];
      const heightPx = u16(bytes, at + 5);
      const widthPx = u16(bytes, at + 7);
      const components = bytes[at + 9];
      if (precision !== 8) throw badRequest('The image must be 8 bits per colour.');
      if (components !== 1 && components !== 3) {
        throw badRequest('The image must be grey or RGB, not CMYK. Save it again as an ordinary JPEG.');
      }
      return { widthPx, heightPx, components };
    }
    at += 2 + length;
  }
  throw badRequest('That JPEG could not be read.');
}

/** The image as the office sent it, checked: its bytes and what is in them. */
export function checkQrImage(base64: string): { bytes: Buffer; info: JpegInfo } {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw badRequest('The image was not sent as base64.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > QR_MAX_BYTES) {
    throw badRequest(`The image is ${Math.round(bytes.length / 1000)} KB; the most is ${QR_MAX_BYTES / 1000} KB.`);
  }
  const info = readJpeg(bytes);
  if (info.widthPx < QR_MIN_PX || info.heightPx < QR_MIN_PX) {
    throw badRequest(
      `The image is ${info.widthPx} × ${info.heightPx} pixels; it needs at least ${QR_MIN_PX} on each side ` +
      'to print sharp at 3 cm.',
    );
  }
  if (info.widthPx > QR_MAX_PX || info.heightPx > QR_MAX_PX) {
    throw badRequest(`The image is larger than ${QR_MAX_PX} pixels a side. Reduce it.`);
  }
  const ratio = info.widthPx / info.heightPx;
  if (ratio < 0.9 || ratio > 1.1) {
    throw badRequest(
      `The image is ${info.widthPx} × ${info.heightPx}: it is not square. Crop it to the QR code alone, ` +
      'without the bank card around it.',
    );
  }
  return { bytes, info };
}

/** Whether the UPI ID and QR columns exist yet (migration 013). */
export async function hasPaymentQr(tx: Queryable): Promise<boolean> {
  const found = await tx.query<{ version: string }>(
    `SELECT version FROM schema_migrations WHERE version = '013_payment_qr.sql'`,
  );
  return found.rows.length > 0;
}

export interface StoredQr {
  readonly jpegBase64: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly components: number;
}

/** The society's QR, with its size read from the image itself, or null when there is none. */
export async function readQr(tx: Queryable, societyId: string): Promise<StoredQr | null> {
  if (!(await hasPaymentQr(tx))) return null;
  const found = await tx.query<{ qr: string | null }>(
    `SELECT encode(pay_qr_jpeg, 'base64') AS qr FROM societies WHERE id = $1`, [societyId],
  );
  const raw = found.rows[0]?.qr;
  if (raw === null || raw === undefined || raw === '') return null;
  // encode() wraps lines; the bytes are what matter.
  const jpegBase64 = raw.replace(/\s+/g, '');
  const info = readJpeg(Buffer.from(jpegBase64, 'base64'));
  return { jpegBase64, ...info };
}
