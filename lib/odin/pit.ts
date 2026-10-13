// ─────────────────────────────────────────────────────────────────
// Tabla de particiones (PIT) — port fiel de libmjolnir (MIT, LineageOS).
// ─────────────────────────────────────────────────────────────────
import { ByteArray } from './packets';

export const PIT_CONSTANTS = {
  FileIdentifier: 0x12349876,
  HeaderDataSize: 28,
  EntryDataSize: 132,
  PartitionNameMaxLength: 32,
  FlashFilenameMaxLength: 32,
  FotaFilenameMaxLength: 32,
};

export enum EntryBinaryType { ApplicationProcessor = 0, CommunicationProcessor = 1 }
export enum EntryDeviceType { OneNand = 0, File = 1, MMC = 2, All = 3, UFS = 8 }

export class PitEntry {
  binaryType: EntryBinaryType = 0;
  deviceType: EntryDeviceType = 0;
  identifier = 0;
  attributes = 0;
  updateAttributes = 0;
  blockSizeOrOffset = 0;
  blockCount = 0;
  fileOffset = 0;
  fileSize = 0;

  _partitionName: Uint8Array<ArrayBufferLike> = new Uint8Array(PIT_CONSTANTS.PartitionNameMaxLength);
  _flashFilename: Uint8Array<ArrayBufferLike> = new Uint8Array(PIT_CONSTANTS.FlashFilenameMaxLength);
  _fotaFilename: Uint8Array<ArrayBufferLike> = new Uint8Array(PIT_CONSTANTS.FotaFilenameMaxLength);

  constructor(entry?: Partial<PitEntry>) {
    if (entry) Object.assign(this, entry);
  }

  get isFlashable() { return !!this.partitionName.trim()?.length; }

  get partitionName() { return ByteArray.toString(this._partitionName); }
  set partitionName(v: string) { this._partitionName = ByteArray.fromString(v, PIT_CONSTANTS.PartitionNameMaxLength); }

  get flashFilename() { return ByteArray.toString(this._flashFilename); }
  set flashFilename(v: string) { this._flashFilename = ByteArray.fromString(v, PIT_CONSTANTS.FlashFilenameMaxLength); }

  get fotaFilename() { return ByteArray.toString(this._fotaFilename); }
  set fotaFilename(v: string) { this._fotaFilename = ByteArray.fromString(v, PIT_CONSTANTS.FotaFilenameMaxLength); }
}

function unpackInt(data: Uint8Array, offset: number): number {
  return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}
function unpackShort(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

export class PitData {
  entryCount = 0;
  entries: PitEntry[] = [];
  lunCount = 0;

  unpack(data: Uint8Array): boolean {
    if (unpackInt(data, 0) !== PIT_CONSTANTS.FileIdentifier) return false;

    this.entryCount = unpackInt(data, 4);
    const requiredSize = PIT_CONSTANTS.HeaderDataSize + this.entryCount * PIT_CONSTANTS.EntryDataSize;
    if (requiredSize > data.length) return false;

    this.lunCount = unpackShort(data, 24);
    this.entries = new Array(this.entryCount);

    for (let i = 0; i < this.entryCount; i++) {
      const o = PIT_CONSTANTS.HeaderDataSize + i * PIT_CONSTANTS.EntryDataSize;
      this.entries[i] = new PitEntry({
        binaryType: unpackInt(data, o),
        deviceType: unpackInt(data, o + 4),
        identifier: unpackInt(data, o + 8),
        attributes: unpackInt(data, o + 12),
        updateAttributes: unpackInt(data, o + 16),
        blockSizeOrOffset: unpackInt(data, o + 20),
        blockCount: unpackInt(data, o + 24),
        fileOffset: unpackInt(data, o + 28),
        fileSize: unpackInt(data, o + 32),
        _partitionName: data.slice(o + 36, o + 36 + PIT_CONSTANTS.PartitionNameMaxLength),
        _flashFilename: data.slice(
          o + 36 + PIT_CONSTANTS.PartitionNameMaxLength,
          o + 36 + PIT_CONSTANTS.PartitionNameMaxLength + PIT_CONSTANTS.FlashFilenameMaxLength,
        ),
        _fotaFilename: data.slice(
          o + 36 + PIT_CONSTANTS.PartitionNameMaxLength + PIT_CONSTANTS.FlashFilenameMaxLength,
          o + 36 + PIT_CONSTANTS.PartitionNameMaxLength + PIT_CONSTANTS.FlashFilenameMaxLength + PIT_CONSTANTS.FotaFilenameMaxLength,
        ),
      });
    }
    return true;
  }

  findEntryByName(partitionName: string): PitEntry | undefined {
    return this.entries.find((e) => e.isFlashable && e.partitionName === partitionName);
  }

  findEntryByFlashFilename(flashFilename: string): PitEntry | undefined {
    const norm = (s: string) => s.replace(/\.(lz4|zst)$/i, '').toLowerCase();
    return this.entries.find((e) => e.isFlashable && e.flashFilename && norm(e.flashFilename) === norm(flashFilename));
  }
}
