// Herramienta de flasheo tipo Odin: detecta el set de archivos (BL/AP/CP/CSC/DATA)
// dentro de una carpeta local y guarda la carpeta preferida + el historial de
// versiones en IndexedDB del navegador. Todo queda en el equipo del técnico,
// nada se sube a la academia.
export type OdinSlot = 'BL' | 'AP' | 'CP' | 'CSC' | 'DATA';

export const ODIN_SLOTS: OdinSlot[] = ['BL', 'AP', 'CP', 'CSC', 'DATA'];

export interface OdinSlotFile {
  name: string;
  size: number;
  handle: FileSystemFileHandle;
}

export interface OdinHistoryEntry {
  id: string;
  ts: number;
  label: string;
  files: Partial<Record<OdinSlot, string>>;
}

// Patrones de nombre típicos de los paquetes de firmware Samsung
// (los mismos 4 archivos que trae cualquier descarga: BL_, AP_, CP_, CSC_ u HOME_CSC_).
// CSC tiene dos variantes en el mismo paquete (CSC_ borra datos, HOME_CSC_ los
// conserva) — van en patrones separados para poder preferir siempre CSC_
// sobre HOME_CSC_ sin depender del orden en que el sistema de archivos
// devuelva los nombres (ese orden no está garantizado entre SO/carpeta).
const SLOT_PATTERNS: Record<OdinSlot, RegExp> = {
  BL: /^BL_/i,
  AP: /^AP_/i,
  CP: /^CP_/i,
  CSC: /^CSC_/i,
  DATA: /^(USERDATA|DATA)_/i,
};
const HOME_CSC_PATTERN = /^HOME_CSC_/i;

/** Agrupa los archivos de una carpeta por slot Odin, según su nombre. */
export function matchFirmwareSet(files: OdinSlotFile[]): Partial<Record<OdinSlot, OdinSlotFile>> {
  const out: Partial<Record<OdinSlot, OdinSlotFile>> = {};
  for (const f of files) {
    for (const slot of ODIN_SLOTS) {
      if (SLOT_PATTERNS[slot].test(f.name)) {
        if (!out[slot]) out[slot] = f;
      }
    }
  }
  // HOME_CSC_ solo se usa como respaldo si no había un CSC_ normal en la carpeta.
  if (!out.CSC) {
    const homeCsc = files.find((f) => HOME_CSC_PATTERN.test(f.name));
    if (homeCsc) out.CSC = homeCsc;
  }
  return out;
}

/**
 * Intenta extraer un identificador de modelo de archivos de firmware Samsung.
 * Los nombres reales incluyen el modelo: AP_SM-A546B_...tar, BL_A526B_..., etc.
 * Normaliza 5.x o 4.x letras+3-4 dígitos (SM-J610F, SM-A546B, SM-S901B...).
 * Devuelve null si no logra inferir nada (p.ej. nombres genéricos "AP.tar").
 */
const MODEL_IN_MARKERS = [
  /SM-[A-Z]?[A-Z0-9]{3,4}[0-9][A-Z0-9]*/i,   // SM-A546B, SM-S911B, SM-T720
  /(?:SM|GT)-[A-Z0-9]+/i,                      // GT-I9300, SM-G935F
];
export function inferModelFromName(name: string): string | null {
  for (const re of MODEL_IN_MARKERS) {
    const m = name.match(re);
    if (m) return m[0].toUpperCase().replace(/^SM-?/i, 'SM-').replace(/^GT-?/i, 'GT-');
  }
  return null;
}

/**
 * Extrae el "bit" (anti-rollback / SW REV) del nombre de un firmware Samsung.
 * El bit es el 5.º carácter desde el final del token de versión (p.ej. en
 * A065MUBS**E**CZG1 el bit es E; en A055MUBS**8**CYC3 es 8). El equipo solo
 * acepta un firmware cuyo bit sea IGUAL o MAYOR al que ya tiene fusionado —
 * si es menor, lo recibe pero lo rechaza al arrancar (anti-rollback) y rebota
 * a modo descarga. Devolver null si no se reconoce un token de versión.
 */
export function inferBitFromName(name: string): { bit: string; version: string } | null {
  // Token de versión: modelo tipo A065M ([A-Z]\d{3}[A-Z]) + región/PDA.
  const m = name.match(/[A-Z]\d{3}[A-Z][A-Z0-9]{7,9}/i);
  if (!m) return null;
  const version = m[0].toUpperCase();
  if (version.length < 5) return null;
  return { bit: version[version.length - 5]!, version };
}

/**
 * Convierte un bit (0-9, luego A-Z) a un valor numérico comparable, para poder
 * decidir si un bit es mayor o menor que otro. Samsung usa 0..9 y después A..Z.
 */
export function bitToValue(bit: string): number {
  const c = bit.toUpperCase().charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;        // '0'..'9' → 0..9
  if (c >= 65 && c <= 90) return 10 + (c - 65); // 'A'..'Z' → 10..35
  return -1;
}

/** Devuelve true si el nombre de archivo de slot CSC es de los que BORRAN datos (CSC_, no HOME_CSC_). */
export function isDestructiveCsc(slot: OdinSlot, fileName: string | undefined): boolean {
  if (!fileName) return false;
  if (slot === 'CSC') return SLOT_PATTERNS.CSC.test(fileName) && !HOME_CSC_PATTERN.test(fileName);
  if (slot === 'DATA') return /\b(userdata|data)\b/i.test(fileName);
  return false;
}

export interface TarEntry { name: string; blob: Blob }

/**
 * Lee las cabeceras de un .tar (sin descomprimir nada: los .lz4 dentro del tar
 * se envían al equipo tal cual, igual que hace Odin — el bootloader los
 * descomprime él mismo) y devuelve cada archivo interno como un Blob recortado
 * del archivo original, sin cargarlo entero en memoria.
 *
 * Maneja tars GNU/paustar reales: prefijo de path (typeflag '5' = directorio),
 * y cabeceras LongLink 'L'/'K' (nombres/rutas largas), el formato que
 * genera Samsung con `tar`. Verifica el checksum del header y aborta si no
 * cuadra (deja de interpretar, no lanza — devuelve lo parseado hasta ahí).
 */
const TAR_BLOCK = 512;
function tarHeaderChecksumOk(header: Uint8Array): boolean {
  // checksum del header: suma de los 512 bytes con el campo checksum (148..156)
  // reemplazado por espacios.
  const sum = header.reduce((acc, b) => acc + b, 0);
  const storedRaw = new TextDecoder('ascii').decode(header.slice(148, 156)).trim();
  const stored = parseInt(storedRaw, 8) || 0;
  if (stored === 0) return true; // 0 = sin checksum (algunos tars no lo escriben)
  // recalculamos sin el campo checksum (como si fueran espacios)
  let calc = 0;
  for (let i = 0; i < TAR_BLOCK; i++) calc += i >= 148 && i < 156 ? 32 : header[i]!;
  return calc === stored || sum === stored;
}
export async function listTarEntries(file: Blob): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  let offset = 0;
  const total = file.size;
  // Buffer acumulado para LongLink (nombre real en cabeceras 'L'/'K')
  let pendingLongName: string | null = null;

  while (offset + TAR_BLOCK <= total) {
    const header = new Uint8Array(await file.slice(offset, offset + TAR_BLOCK).arrayBuffer());
    if (header.every((b) => b === 0)) break; // bloque vacío = fin del archivo

    const nameRaw = new TextDecoder('ascii').decode(header.slice(0, 100)).replace(/\0.*$/, '').trim();
    const prefixRaw = new TextDecoder('ascii').decode(header.slice(345, 500)).replace(/\0.*$/, '').trim();
    const sizeStr = new TextDecoder('ascii').decode(header.slice(124, 136)).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156] ?? 0);

    // Bloque de datos real del contenido (para saltarlo)
    const dataBlocks = Math.ceil(size / TAR_BLOCK);

    // Sanity: si el checksum no cuadra, paramos (el archivo no es un tar limpio)
    if (!tarHeaderChecksumOk(header)) {
      // no lanzamos — mejor devolvemos lo que ya tenemos que fallar a mitad
      break;
    }

    if (typeflag === 'L' || typeflag === 'K') {
      // LongLink: la siguiente cabecera usa este nombre en vez del suyo.
      // El nombre viene en el bloque de datos.
      const nameBytes = new Uint8Array(await file.slice(offset + TAR_BLOCK, offset + TAR_BLOCK + size).arrayBuffer());
      pendingLongName = new TextDecoder('ascii').decode(nameBytes).replace(/\0.*$/, '').trim();
      offset += TAR_BLOCK + dataBlocks * TAR_BLOCK;
      continue;
    }

    let name = nameRaw;
    if (pendingLongName) {
      name = pendingLongName;
      pendingLongName = null;
    } else if (prefixRaw) {
      name = prefixRaw + '/' + name;
    }

    // typeflag '5' = directorio: no es un archivo real, se salta.
    if (name && (typeflag === '0' || typeflag === '\0') && size > 0) {
      entries.push({ name, blob: file.slice(offset + TAR_BLOCK, offset + TAR_BLOCK + size) });
    }

    offset += TAR_BLOCK + dataBlocks * TAR_BLOCK;
  }
  return entries;
}

/** Quita sufijos de compresión (.lz4, .zst) para comparar nombres del PIT contra el tar. */
export function stripCompressionSuffix(name: string): string {
  return name.replace(/\.(lz4|zst)$/i, '').toLowerCase();
}

/** Lista los archivos .tar.md5/.tar/.md5 de un directorio (no recursivo). */
export async function listFirmwareFiles(dir: FileSystemDirectoryHandle): Promise<OdinSlotFile[]> {
  const out: OdinSlotFile[] = [];
  // @ts-expect-error: values() existe en runtime (File System Access API) aunque TS lib.dom no lo tipe en todos los targets
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    if (!/\.(tar(\.md5)?|md5|img|bin)$/i.test(name)) continue;
    const file = await handle.getFile();
    out.push({ name, size: file.size, handle });
  }
  return out;
}

// ── IndexedDB: carpeta preferida + historial ──
const DB_NAME = 'odin-flash-tool';
const DB_VERSION = 1;
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const FOLDER_KEY = 'preferredFolder';
const HISTORY_KEY = 'history';

export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await kvSet(FOLDER_KEY, handle);
}

export async function loadFolderHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  return kvGet<FileSystemDirectoryHandle>(FOLDER_KEY);
}

export async function loadHistory(): Promise<OdinHistoryEntry[]> {
  return (await kvGet<OdinHistoryEntry[]>(HISTORY_KEY)) ?? [];
}

export async function pushHistory(entry: OdinHistoryEntry): Promise<OdinHistoryEntry[]> {
  const list = await loadHistory();
  const next = [entry, ...list].slice(0, 20);
  await kvSet(HISTORY_KEY, next);
  return next;
}
