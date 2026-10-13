// ─────────────────────────────────────────────────────────────────
// MD5 (RFC 1321) en streaming + verificación del trailer .tar.md5 de
// Samsung — igual al "Check MD5" de Odin.exe: el archivo trae el hash
// MD5 de su propio contenido pegado al final; esto lo recalcula y lo
// compara ANTES de flashear, para detectar un .tar.md5 corrupto o mal
// descargado sin tener que esperar a que falle a mitad de la escritura.
// ─────────────────────────────────────────────────────────────────
import type { OdinLogFn } from './device';

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

export class MD5 {
  private a0 = 0x67452301;
  private b0 = 0xefcdab89;
  private c0 = 0x98badcfe;
  private d0 = 0x10325476;
  private buffer = new Uint8Array(64);
  private bufLen = 0;
  private totalLenBig = 0n;

  update(data: Uint8Array) {
    this.totalLenBig += BigInt(data.length);
    let offset = 0;

    if (this.bufLen > 0) {
      const need = 64 - this.bufLen;
      const take = Math.min(need, data.length);
      this.buffer.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      offset += take;
      if (this.bufLen === 64) {
        this.processBlock(this.buffer);
        this.bufLen = 0;
      }
    }

    while (offset + 64 <= data.length) {
      this.processBlock(data.subarray(offset, offset + 64));
      offset += 64;
    }

    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufLen = data.length - offset;
    }
  }

  private processBlock(block: Uint8Array) {
    const view = new DataView(block.buffer, block.byteOffset, 64);
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(i * 4, true);

    let A = this.a0, B = this.b0, C = this.c0, D = this.d0;

    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i]!)) >>> 0;
    }

    this.a0 = (this.a0 + A) >>> 0;
    this.b0 = (this.b0 + B) >>> 0;
    this.c0 = (this.c0 + C) >>> 0;
    this.d0 = (this.d0 + D) >>> 0;
  }

  digestHex(): string {
    const bitLenBig = this.totalLenBig * 8n;
    const msgLen = this.bufLen;
    const padLen = msgLen < 56 ? 56 - msgLen : 120 - msgLen;
    const finalBlock = new Uint8Array(msgLen + padLen + 8);
    finalBlock.set(this.buffer.subarray(0, msgLen), 0);
    finalBlock[msgLen] = 0x80;
    new DataView(finalBlock.buffer).setBigUint64(finalBlock.length - 8, bitLenBig, true);

    for (let off = 0; off < finalBlock.length; off += 64) {
      this.processBlock(finalBlock.subarray(off, off + 64));
    }

    const toHex = (n: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n, true);
      return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    return toHex(this.a0) + toHex(this.b0) + toHex(this.c0) + toHex(this.d0);
  }
}

/**
 * Verifica un .tar.md5 de Samsung: el MD5 (32 caracteres hex) viene pegado
 * al final del propio archivo, hasheando todo el contenido ANTES de ese
 * trailer. Devuelve true/false si pudo comparar, o null si no encontró un
 * trailer reconocible (no bloquea el flasheo en ese caso).
 */
export async function verifyTarMd5(file: Blob, log: OdinLogFn): Promise<boolean | null> {
  const tailSize = Math.min(256, file.size);
  const tailBytes = new Uint8Array(await file.slice(file.size - tailSize, file.size).arrayBuffer());
  const tailText = new TextDecoder('ascii', { fatal: false }).decode(tailBytes);
  const match = tailText.match(/([0-9a-fA-F]{32})\s*$/);
  if (!match) {
    log('   (sin trailer MD5 reconocible al final del archivo, se omite la verificación)', 'warn');
    return null;
  }
  const expected = match[1]!.toLowerCase();
  const trailerStartInTail = tailText.lastIndexOf(match[1]!);
  const contentSize = file.size - tailSize + trailerStartInTail;

  log(`   Verificando MD5 (${(contentSize / 1048576).toFixed(0)} MB)...`, 'info');

  const md5 = new MD5();
  const CHUNK = 8 * 1024 * 1024;
  for (let offset = 0; offset < contentSize; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, contentSize);
    md5.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
  }
  const actual = md5.digestHex();
  const ok = actual === expected;

  if (ok) log(`   ✅ MD5 correcto (${expected})`, 'ok');
  else log(`   ❌ MD5 no coincide — esperado ${expected}, calculado ${actual}`, 'error');

  return ok;
}
