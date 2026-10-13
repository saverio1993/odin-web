// ─────────────────────────────────────────────────────────────────
// Protocolo Odin — paquetes de control y PIT.
// Port fiel de libmjolnir (github.com/lineageos-infra/libmjolnir),
// la librería TypeScript que usa LineageOS para flashear Samsung desde
// el navegador (WebUSB/WebSerial). MIT License, Copyright (c) 2023
// Greg Willard. Adaptado a este proyecto manteniendo exactamente la
// misma estructura de paquetes y offsets.
// ─────────────────────────────────────────────────────────────────

export const ByteArray = {
  fromString(message: string, length?: number): Uint8Array {
    const encoded = new TextEncoder().encode(message);
    const size = length ?? encoded.byteLength;
    const byteArray = new Uint8Array(size);
    byteArray.set(encoded.subarray(0, size));
    return byteArray;
  },
  toString(byteData: Uint8Array): string {
    const end = byteData.indexOf(0);
    const slice = byteData.subarray(0, end === -1 ? byteData.length : end);
    return new TextDecoder().decode(slice);
  },
};

// ── Base ──
export class BasePacket {
  size: number;
  data: Uint8Array;
  constructor(size: number) {
    this.size = size;
    this.data = new Uint8Array(size);
  }
}

// ── Outbound ──
export enum EmptySendKind { None = 0, Before = 1 << 0, After = 1 << 1, BeforeAndAfter = (1 << 0) | (1 << 1) }

export class OutboundPacket extends BasePacket {
  packInteger(offset: number, value: number) {
    this.data[offset] = value & 0x000000ff;
    this.data[offset + 1] = (value & 0x0000ff00) >> 8;
    this.data[offset + 2] = (value & 0x00ff0000) >> 16;
    this.data[offset + 3] = (value & 0xff000000) >> 24;
  }
  pack(): void {
    throw new Error('Packet has not implemented the `pack` method');
  }
}

export enum ControlType { Session = 0x64, PitFile = 0x65, FileTransfer = 0x66, EndSession = 0x67 }

export class ControlPacket extends OutboundPacket {
  controlType: ControlType;
  constructor(controlType: ControlType) {
    super(1024);
    this.controlType = controlType;
  }
  static dataSize = 4;
  override pack() {
    this.packInteger(0, this.controlType);
  }
}

export enum SessionRequest {
  BeginSession = 0, DeviceType = 1, TotalBytes = 2, FilePartSize = 5, EraseUserdata = 7, EnableTFlash = 8,
}

export class SessionSetupPacket extends ControlPacket {
  request: SessionRequest;
  constructor(request: SessionRequest) {
    super(ControlType.Session);
    this.request = request;
  }
  static override dataSize = ControlPacket.dataSize + 4;
  override pack() {
    super.pack();
    this.packInteger(ControlPacket.dataSize, this.request);
  }
}

export class BeginSessionPacket extends SessionSetupPacket {
  constructor() { super(SessionRequest.BeginSession); }
  static override dataSize = SessionSetupPacket.dataSize + 4;
  override pack() {
    super.pack();
    // Versión de protocolo del host. Captura USB de odin4 v1.2.13 flasheando
    // un A065M (13/10/2026): manda `64 00 05` y el equipo responde 0x20000.
    this.packInteger(SessionSetupPacket.dataSize, 5);
  }
}

export class FilePartSizePacket extends SessionSetupPacket {
  constructor(private filePartSize: number) { super(SessionRequest.FilePartSize); }
  override pack() {
    super.pack();
    this.packInteger(SessionSetupPacket.dataSize, this.filePartSize);
  }
}

export class TotalBytesPacket extends SessionSetupPacket {
  constructor(private fileTotalSize: number) { super(SessionRequest.TotalBytes); }
  override pack() {
    super.pack();
    this.packInteger(SessionSetupPacket.dataSize, this.fileTotalSize);
    this.packInteger(SessionSetupPacket.dataSize + 4, Math.floor(this.fileTotalSize / 0x100000000));
  }
}

export class EraseUserdataPacket extends SessionSetupPacket {
  constructor() { super(SessionRequest.EraseUserdata); }
}

export enum PitFileRequest { Flash = 0x00, Dump = 0x01, Part = 0x02, EndTransfer = 0x03 }

export class PitFilePacket extends ControlPacket {
  request: PitFileRequest;
  constructor(request: PitFileRequest) {
    super(ControlType.PitFile);
    this.request = request;
  }
  static override dataSize = ControlPacket.dataSize + 4;
  override pack() {
    super.pack();
    this.packInteger(ControlPacket.dataSize, this.request);
  }
}

export class DumpPartPitFilePacket extends PitFilePacket {
  constructor(private partIndex: number) { super(PitFileRequest.Part); }
  override pack() {
    super.pack();
    this.packInteger(PitFilePacket.dataSize, this.partIndex);
  }
}

export class FlashPartPitFilePacket extends PitFilePacket {
  constructor(private fileSize: number) { super(PitFileRequest.Part); }
  override pack() {
    super.pack();
    this.packInteger(PitFilePacket.dataSize, this.fileSize);
  }
}

export class EndPitFileTransferPacket extends PitFilePacket {
  constructor(private fileSize: number) { super(PitFileRequest.EndTransfer); }
  override pack() {
    super.pack();
    this.packInteger(PitFilePacket.dataSize, this.fileSize);
  }
}

export enum FileTransferRequest {
  Flash = 0x00, Dump = 0x01, Part = 0x02, End = 0x03, Lz4Flash = 0x05, Lz4Part = 0x06, Lz4End = 0x07,
}

export class FileTransferPacket extends ControlPacket {
  request: FileTransferRequest;
  constructor(request: FileTransferRequest) {
    super(ControlType.FileTransfer);
    this.request = request;
  }
  static override dataSize = ControlPacket.dataSize + 4;
  override pack() {
    super.pack();
    this.packInteger(ControlPacket.dataSize, this.request);
  }
}

export class FlashPartFileTransferPacket extends FileTransferPacket {
  constructor(private sequenceByteCount: number, lz4 = false) {
    super(lz4 ? FileTransferRequest.Lz4Part : FileTransferRequest.Part);
  }
  override pack() {
    super.pack();
    this.packInteger(FileTransferPacket.dataSize, this.sequenceByteCount);
  }
}

export enum FileTransferDestination { Phone = 0x00, Modem = 0x01 }

export class EndFileTransferPacket extends FileTransferPacket {
  constructor(
    protected destination: FileTransferDestination,
    protected sequenceByteCount: number,
    protected binaryType: number,
    protected deviceType: number,
    lz4 = false,
  ) {
    super(lz4 ? FileTransferRequest.Lz4End : FileTransferRequest.End);
  }
  static override dataSize = FileTransferPacket.dataSize + 16;
  override pack() {
    super.pack();
    this.packInteger(FileTransferPacket.dataSize, this.destination);
    this.packInteger(FileTransferPacket.dataSize + 4, this.sequenceByteCount);
    this.packInteger(FileTransferPacket.dataSize + 8, this.binaryType);
    this.packInteger(FileTransferPacket.dataSize + 12, this.deviceType);
  }
}

export class EndPhoneFileTransferPacket extends EndFileTransferPacket {
  private endOfFile: number;
  constructor(
    sequenceByteCount: number, binaryType: number, chipIdentifier: number,
    private fileIdentifier: number, endOfFile: boolean, lz4 = false,
  ) {
    super(FileTransferDestination.Phone, sequenceByteCount, binaryType, chipIdentifier, lz4);
    this.endOfFile = endOfFile ? 1 : 0;
  }
  override pack() {
    super.pack();
    this.packInteger(EndFileTransferPacket.dataSize, this.fileIdentifier);
    this.packInteger(EndFileTransferPacket.dataSize + 4, this.endOfFile);
  }
}

export class EndModemFileTransferPacket extends EndFileTransferPacket {
  private endOfFile: number;
  constructor(sequenceByteCount: number, binaryType: number, chipIdentifier: number, endOfFile: boolean, lz4 = false) {
    super(FileTransferDestination.Modem, sequenceByteCount, binaryType, chipIdentifier, lz4);
    this.endOfFile = endOfFile ? 1 : 0;
  }
  override pack() {
    super.pack();
    this.packInteger(EndFileTransferPacket.dataSize, this.endOfFile);
  }
}

export class SendFilePartPacket extends OutboundPacket {
  constructor(byteData: Uint8Array, size: number) {
    super(size);
    this.data.set(byteData);
  }
  override pack() { /* ya está empaquetado */ }
}

export enum EndSessionRequest { EndSession = 0, RebootDevice = 1 }

export class EndSessionPacket extends ControlPacket {
  constructor(private request: EndSessionRequest) { super(ControlType.EndSession); }
  override pack() {
    super.pack();
    this.packInteger(ControlPacket.dataSize, this.request);
  }
}

// ── Inbound ──
export class InboundPacket extends BasePacket {
  sizeVariable: boolean;
  receivedSize = -1;
  constructor(size: number, sizeVariable = false) {
    super(size);
    this.sizeVariable = sizeVariable;
  }
  unpackInteger(offset: number): number {
    return (
      (this.data[offset]! |
        (this.data[offset + 1]! << 8) |
        (this.data[offset + 2]! << 16) |
        (this.data[offset + 3]! << 24)) >>> 0
    );
  }
  unpack(): Promise<void> {
    return Promise.reject(new Error('Packet has not implemented the `unpack` method'));
  }
}

export enum ResponseType { SendFilePart = 0x00, SessionSetup = 0x64, PitFile = 0x65, FileTransfer = 0x66, EndSession = 0x67 }

export class ResponsePacket extends InboundPacket {
  responseType: ResponseType;
  constructor(responseType: ResponseType) {
    super(8);
    this.responseType = responseType;
  }
  static dataSize = 4;
  override unpack(): Promise<void> {
    const receivedResponseType = this.unpackInteger(0) as ResponseType;
    if (receivedResponseType !== this.responseType) {
      this.responseType = receivedResponseType;
      return Promise.reject(new Error('requested and received response types differ'));
    }
    return Promise.resolve();
  }
}

export class SessionSetupResponse extends ResponsePacket {
  result = 0;
  constructor() { super(ResponseType.SessionSetup); }
  override async unpack() {
    await super.unpack();
    this.result = this.unpackInteger(ResponsePacket.dataSize);
  }
}

export class EndSessionResponse extends ResponsePacket {
  constructor() { super(ResponseType.EndSession); }
}

export class FileTransferResponse extends ResponsePacket {
  constructor() { super(ResponseType.FileTransfer); }
}

export class PitFileResponse extends ResponsePacket {
  fileSize = 0;
  constructor() { super(ResponseType.PitFile); }
  override async unpack() {
    await super.unpack();
    this.fileSize = this.unpackInteger(ResponsePacket.dataSize);
  }
}

export class SendFilePartResponse extends ResponsePacket {
  partIndex = -1;
  constructor() { super(ResponseType.SendFilePart); }
  override async unpack() {
    await super.unpack();
    this.partIndex = this.unpackInteger(ResponsePacket.dataSize);
  }
}

export class ReceiveFilePartPacket extends InboundPacket {
  static dataSize = 500;
  constructor() { super(ReceiveFilePartPacket.dataSize, true); }
  override async unpack() { /* intencionalmente vacío */ }
}
