// Utilidades para flashear firmware estilo Odin: TAR -> LZ4 -> flash por PIT
import { OdinDevice, libpit } from 'libmjolnir';
import * as LZ4 from 'lz4js';

export type TarEntry = { name: string, data: Uint8Array };
export type PlanItem = {
  slot: string;
  fileName: string;     // nombre dentro del TAR (p.ej. boot.img.lz4)
  baseName: string;     // sin .lz4 (p.ej. boot.img)
  compressed: boolean;
  partitionName?: string;
  identifier?: number;
  deviceType?: number;
  matched: boolean;
  size: number;         // tamaño del archivo (comprimido si .lz4)
};

const td = new TextDecoder();

/** Lee un entero octal de una cabecera TAR */
function parseOctal (bytes: Uint8Array): number {
  const s = td.decode(bytes).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

/** ¿Parece una cabecera TAR válida? (ustar o checksum coherente) */
function looksLikeTar (buf: Uint8Array): boolean {
  if (buf.length < 512) return false;
  const magic = td.decode(buf.slice(257, 262));
  return magic === 'ustar';
}

/**
 * Parsea un TAR (incluye .tar.md5 — el MD5 va tras los bloques cero finales y se ignora).
 * Soporta prefijo ustar para nombres largos.
 */
export function parseTar (buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    // Bloque cero => fin del archivo
    let allZero = true;
    for (let i = 0; i < 512; i++) { if (header[i] !== 0) { allZero = false; break; } }
    if (allZero) break;

    let name = td.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const prefix = td.decode(header.subarray(345, 500)).replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;

    const size = parseOctal(header.subarray(124, 136));
    const typeFlag = String.fromCharCode(header[156]);

    const dataStart = offset + 512;
    // typeFlag '0' o '\0' = archivo normal
    if ((typeFlag === '0' || typeFlag === '\0') && name && size >= 0) {
      entries.push({ name, data: buf.subarray(dataStart, dataStart + size) });
    }

    // Avanza: cabecera + datos redondeados a 512
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

/** Si el nombre acaba en .lz4, descomprime (formato LZ4 frame de Samsung) */
export function decompressIfNeeded (name: string, data: Uint8Array): { name: string, data: Uint8Array } {
  if (/\.lz4$/i.test(name)) {
    const out = LZ4.decompress(data);
    return { name: name.replace(/\.lz4$/i, ''), data: out instanceof Uint8Array ? out : new Uint8Array(out) };
  }
  return { name, data };
}

/** Convierte el contenido de un slot (archivo del usuario) en entradas de imagen */
export function slotToEntries (fileName: string, buf: Uint8Array): TarEntry[] {
  if (looksLikeTar(buf) || /\.tar(\.md5)?$/i.test(fileName)) {
    return parseTar(buf);
  }
  // Archivo suelto: una sola imagen (.img o .img.lz4)
  return [{ name: fileName, data: buf }];
}

/** Busca la entrada de la PIT cuyo flashFilename coincide con el nombre base */
export function matchPitEntry (pit: libpit.PitData, baseName: string): libpit.PitEntry | undefined {
  const target = baseName.toLowerCase();
  return pit.entries.find(e => e.flashFilename && e.flashFilename.toLowerCase() === target);
}

/** Dry-run: construye el plan (qué imagen va a qué partición) sin flashear nada */
export function analyzeFirmware (
  slots: { slot: string, fileName: string, buf: Uint8Array }[],
  pit: libpit.PitData
): PlanItem[] {
  const plan: PlanItem[] = [];
  for (const { slot, fileName, buf } of slots) {
    const entries = slotToEntries(fileName, buf);
    for (const entry of entries) {
      const compressed = /\.lz4$/i.test(entry.name);
      const baseName = entry.name.replace(/\.lz4$/i, '');
      const pitEntry = matchPitEntry(pit, baseName);
      plan.push({
        slot,
        fileName: entry.name,
        baseName,
        compressed,
        matched: !!pitEntry,
        partitionName: pitEntry?.partitionName,
        identifier: pitEntry?.identifier,
        deviceType: pitEntry?.deviceType,
        size: entry.data.length
      });
    }
  }
  return plan;
}

export type FlashProgress = (msg: string, type?: string) => void;

/**
 * Flashea un firmware completo estilo Odin:
 *  beginSession -> getPitData -> (por cada imagen: descomprime -> setFlashTotalSize + sendFile) -> endSession(reboot)
 * Usa una sola sesión para todas las particiones (no begin/end por archivo).
 */
export async function flashFirmware (
  device: OdinDevice,
  slots: { slot: string, fileName: string, buf: Uint8Array }[],
  opts: { reboot: boolean, log: FlashProgress }
): Promise<void> {
  const { log } = opts;
  const anyDevice = device as any; // sendFile/setFlashTotalSize son públicos pero sin tipos export

  log('Abriendo sesión (beginSession)...', 'info');
  await device.beginSession();

  log('Descargando PIT del dispositivo...', 'info');
  const pit = await device.getPitData();
  log(`PIT: boardType=${pit.boardType}, ${pit.entries.length} particiones`, 'log');

  // Destination.Phone = 0 según el enum del protocolo
  const PHONE_DEST = 0;

  let flashed = 0, skipped = 0;
  for (const { slot, fileName, buf } of slots) {
    const entries = slotToEntries(fileName, buf);
    log(`[${slot}] ${fileName}: ${entries.length} imagen(es)`, 'info');

    for (const raw of entries) {
      const baseName = raw.name.replace(/\.lz4$/i, '');
      const pitEntry = matchPitEntry(pit, baseName);
      if (!pitEntry) {
        log(`  ↷ omitido (sin partición en PIT): ${raw.name}`, 'warn');
        skipped++;
        continue;
      }

      let data = raw.data;
      if (/\.lz4$/i.test(raw.name)) {
        log(`  ⇩ descomprimiendo ${raw.name} (${(data.length/1048576).toFixed(1)} MB)...`, 'log');
        const out = LZ4.decompress(data);
        data = out instanceof Uint8Array ? out : new Uint8Array(out);
      }

      log(`  ⚡ flasheando ${baseName} → ${pitEntry.partitionName} (${(data.length/1048576).toFixed(1)} MB)...`, 'log');
      await anyDevice.setFlashTotalSize(data.byteLength);
      await anyDevice.sendFile(data, PHONE_DEST, pitEntry.deviceType, pitEntry.identifier);
      log(`  ✔ ${pitEntry.partitionName} OK`, 'log');
      flashed++;
    }
  }

  log(`Finalizando sesión${opts.reboot ? ' y reiniciando' : ''}...`, 'info');
  await device.endSession(opts.reboot);

  log(`Flasheo completado: ${flashed} particiones escritas, ${skipped} omitidas.`, 'info');
}
