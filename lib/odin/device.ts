// ─────────────────────────────────────────────────────────────────
// OdinDevice — port fiel de libmjolnir (MIT, LineageOS: github.com/
// lineageos-infra/libmjolnir). Orquesta el protocolo completo sobre
// cualquier OdinTransport (aquí, WebSerialTransport).
//
// El orden y el contenido de los paquetes replican byte a byte una captura
// USB (USBPcap) de odin4 v1.2.13 flasheando un SM-A065M con éxito:
//   ODIN/LOKE → 64/0 (5) → 64/5 (1 MiB) → 64/2 (total) → 65/0 flash PIT →
//   65/1 dump PIT → por cada tramo de cada archivo: 66/0, 66/2, datos, 66/3 →
//   67/0 → 67/1.
// ─────────────────────────────────────────────────────────────────
import { EntryBinaryType, PitData } from './pit';
import {
  ByteArray, EmptySendKind, OutboundPacket, InboundPacket,
  BeginSessionPacket, DumpPartPitFilePacket,
  EndModemFileTransferPacket, EndPhoneFileTransferPacket, EndPitFileTransferPacket,
  EndSessionPacket, EndSessionRequest, EraseUserdataPacket, FilePartSizePacket,
  FileTransferPacket, FileTransferRequest, FlashPartFileTransferPacket, FlashPartPitFilePacket,
  PitFilePacket, PitFileRequest, SendFilePartPacket, SessionSetupResponse,
  EndSessionResponse, FileTransferResponse, PitFileResponse, ReceiveFilePartPacket,
  SendFilePartResponse, TotalBytesPacket,
} from './packets';
import { OdinTransport } from './transport';
import { isLz4Frame, lz4Sequences, parseLz4FrameHeader, type Lz4Sequence } from './lz4';
import { Lz4DecompressClient } from './lz4-worker-client';

export type OdinLogFn = (msg: string, type?: 'ok' | 'error' | 'warn' | 'info' | 'title') => void;

export type DeviceOptions = {
  timeout: number;
  log: OdinLogFn;
  onProgress?: (fraction: number) => void;
};

const EMPTY_TRANSFER_TIMEOUT = 100;
// odin4 anuncia cada tramo redondeado a múltiplos de 128 KiB (ej. 0x2280 →
// 0x20000, 0x156088 → 0x160000), aunque después mande paquetes de 1 MiB.
const SEQUENCE_ALIGNMENT = 0x20000;

const DEFAULT_OPTIONS: Omit<DeviceOptions, 'log'> = { timeout: 10000 };

export class OdinDevice {
  transport: OdinTransport;
  options: DeviceOptions;

  _devicePit?: PitData;
  _devicePitRaw?: Uint8Array;
  _flashTimeout = 30_000;
  _flashSequence = 800;
  _flashPacketSize = 131072;
  _flashSessionStarted = false;
  _lz4Supported = false;
  _lz4Worker?: Lz4DecompressClient;

  constructor(transport: OdinTransport, options: Partial<DeviceOptions> & { log: OdinLogFn }) {
    this.transport = transport;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get pit() { return this._devicePit; }
  /** El PIT tal como lo mandó el equipo (para guardarlo como .pit). */
  get pitRaw() { return this._devicePitRaw; }
  get lz4Supported() { return this._lz4Supported; }

  private log(msg: string, type?: Parameters<OdinLogFn>[1]) { this.options.log(msg, type); }

  async initialize() {
    await this.transport.connect(this.options.timeout);
    await this.handshake();
  }

  async handshake() {
    this.log('🤝 Handshake ODIN/LOKE...', 'info');
    await this.transport.send(ByteArray.fromString('ODIN'), this.options.timeout);
    const response = await this.transport.receive(4, this.options.timeout);
    const result = ByteArray.toString(response);
    this.log(`   ← ${result}`, 'info');
    if (result !== 'LOKE') throw new Error('handshake challenge mismatch');
    this.log('✅ Handshake OK', 'ok');
  }

  async close() {
    this._lz4Worker?.terminate();
    this._lz4Worker = undefined;
    await this.transport.close(this.options.timeout);
  }

  async beginSession(forceBegin = false) {
    if (this._flashSessionStarted && !forceBegin) return;

    this.log('📋 Begin Session...', 'info');
    await this.sendPacket(new BeginSessionPacket());
    const resp = await this.receivePacket(SessionSetupResponse);

    // Decode EXACTO de odin4 (odin_begin_session):
    //   ack_upper = ack >> 16
    //   soporta comprimido = (ack_upper & 0x8000) != 0
    //   version           = ack_upper & 0x7FFF
    // Según la versión, odin4 elige los parámetros de flasheo y, solo si
    // version > 1, negocia el tamaño de paquete de 1 MiB.
    const ack = resp.result >>> 0;
    const ackUpper = (ack >>> 16) & 0xffff;
    this._lz4Supported = (ackUpper & 0x8000) !== 0;
    const version = ackUpper & 0x7fff;
    this.log(`   ack=0x${ack.toString(16)} version=${version} (lz4: ${this._lz4Supported})`, 'info');

    if (version <= 1) {
      // Protocolo viejo: paquetes de 128 KiB, 240 por secuencia, sin negociar.
      this._flashTimeout = 30_000;
      this._flashPacketSize = 131072;
      this._flashSequence = 240;
      this.log('   Protocolo v<=1: paquetes de 131072 B, 240 por secuencia', 'info');
    } else {
      // Protocolo nuevo: negociar paquetes de 1 MiB, 30 por secuencia.
      this._flashTimeout = 120_000;
      await this.setFlashPacketSize(1048576, 30);
    }

    this._flashSessionStarted = true;
    this.log('✅ Sesión iniciada', 'ok');
  }

  async setFlashPacketSize(packetSize: number, sequence: number) {
    await this.sendPacket(new FilePartSizePacket(packetSize));
    const resp = await this.receivePacket(SessionSetupResponse);
    if (resp.result !== 0) throw new Error(`Unexpected file part size response: ${resp.result}`);
    this._flashPacketSize = packetSize;
    this._flashSequence = sequence;
    this.log(`   Tamaño de paquete negociado: ${packetSize} bytes`, 'info');
  }

  async setFlashTotalSize(totalSize: number) {
    await this.sendPacket(new TotalBytesPacket(totalSize));
    const resp = await this.receivePacket(SessionSetupResponse);
    if (resp.result !== 0) throw new Error(`Unexpected total size response: ${resp.result}`);
  }

  async endSession(reboot = false, forceEnd = false) {
    if (!this._flashSessionStarted && !forceEnd) return;
    // odin4 siempre cierra con 67/0 (End Session) y, para reiniciar, manda
    // DESPUÉS 67/1 (Reboot). El equipo tarda ~2.3 s en responder el 67/0.
    const requests = reboot ? [EndSessionRequest.EndSession, EndSessionRequest.RebootDevice] : [EndSessionRequest.EndSession];
    for (const request of requests) {
      this.log(request === EndSessionRequest.RebootDevice ? '🔄 Reboot...' : '🔚 End Session...', 'info');
      await this.sendPacket(new EndSessionPacket(request));
      // Best-effort: después de operaciones como Erase Userdata el equipo a
      // veces ya está ocupado reiniciando/limpiando y la respuesta de cierre
      // no llega exactamente con la forma esperada. La operación real (lo que
      // importa) ya se hizo antes de llegar aquí, así que esto no debe tirar
      // un error que tape ese resultado.
      try {
        await this.receivePacket(EndSessionResponse, this._flashTimeout);
      } catch (e) {
        this.log(`   (cierre de sesión no confirmado: ${e instanceof Error ? e.message : String(e)} — no es grave)`, 'warn');
      }
    }
    this._flashSessionStarted = false;
  }

  async reboot() {
    await this.endSession(true, true);
  }

  async eraseUserdata() {
    await this.sendPacket(new EraseUserdataPacket());
    await this.receivePacket(SessionSetupResponse);
  }

  /**
   * Escribe el PIT (el .pit que trae el CSC). odin4 lo hace SIEMPRE que el
   * lote trae un .pit, antes de leer el PIT del equipo y de mandar archivos:
   * 65/0 → 65/2 tamaño → PIT crudo en un solo envío → 65/3 tamaño.
   * Si el equipo tiene MDM/bloqueo responde ffffffff en el 65/3.
   */
  async flashPit(pitFile: Uint8Array) {
    this.log(`📝 Escribiendo PIT (${pitFile.length} bytes)...`, 'info');
    await this.sendPacket(new PitFilePacket(PitFileRequest.Flash));
    await this.receivePacket(PitFileResponse);
    await this.sendPacket(new FlashPartPitFilePacket(pitFile.length));
    await this.receivePacket(PitFileResponse);
    await this.sendPacket(new SendFilePartPacket(pitFile, pitFile.length), EmptySendKind.None);
    await this.receivePacket(PitFileResponse, undefined, undefined, 'datos del PIT');
    await this.sendPacket(new EndPitFileTransferPacket(pitFile.length));
    await this.receivePacket(PitFileResponse, undefined, undefined, 'cerrar PIT (si es ffffffff: MDM/bloqueo)');
    this.log('✅ PIT escrito', 'ok');
  }

  async getPitData(): Promise<PitData> {
    this.log('📊 Leyendo PIT...', 'info');
    await this.sendPacket(new PitFilePacket(PitFileRequest.Dump));
    const dumpResponse = await this.receivePacket(PitFileResponse);

    const fileSize = dumpResponse.fileSize;
    this.log(`   Tamaño del PIT: ${fileSize} bytes`, 'info');
    const transferCount = Math.ceil(fileSize / ReceiveFilePartPacket.dataSize);

    const fileData = new Uint8Array(fileSize);
    let offset = 0;

    for (let i = 0; i < transferCount; i++) {
      this.log(`   parte ${i + 1}/${transferCount}...`, 'info');
      await this.sendPacket(new DumpPartPitFilePacket(i));
      const expectedSize = Math.min(ReceiveFilePartPacket.dataSize, fileSize - offset);
      const part = await this.receivePacket(ReceiveFilePartPacket, 15000, expectedSize);
      fileData.set(part.data, offset);
      offset += part.receivedSize;
    }

    await this._emptyReceive();

    try {
      await this.sendPacket(new PitFilePacket(PitFileRequest.EndTransfer));
      await this.receivePacket(PitFileResponse);
    } catch {
      this.log('   (no se pudo cerrar formalmente la transferencia del PIT, se sigue igual)', 'warn');
    }

    const pitData = new PitData();
    if (!pitData.unpack(fileData)) throw new Error('No se pudo interpretar el PIT recibido');

    this.log(`✅ PIT leído: ${pitData.entries.length} particiones`, 'ok');
    this._devicePit = pitData;
    this._devicePitRaw = fileData;
    return pitData;
  }

  /** Flashea un archivo (ya identificado contra el PIT) a una partición. */
  async sendFile(fileData: Blob, binaryType: EntryBinaryType, deviceType: number, fileIdentifier: number) {
    const fileSize = fileData.size;
    const maxSequenceByteCount = this._flashSequence * this._flashPacketSize;
    const sequenceCount = Math.ceil(fileSize / maxSequenceByteCount) || 1;
    const progress = { sent: 0, total: fileSize, lastPct: -1 };

    for (let sequenceIndex = 0; sequenceIndex < sequenceCount; sequenceIndex++) {
      const startOffset = sequenceIndex * maxSequenceByteCount;
      const sequenceData = fileData.slice(startOffset, Math.min(startOffset + maxSequenceByteCount, fileSize));
      const isLastSequence = sequenceIndex === sequenceCount - 1;

      await this._sendFileSequence(sequenceData, sequenceData.size, binaryType, deviceType, fileIdentifier, isLastSequence, false, progress);
    }
  }

  /** Flashea un archivo .lz4 — por seguridad siempre se descomprime en el host. */
  async sendLz4File(fileData: Blob, binaryType: EntryBinaryType, deviceType: number, fileIdentifier: number) {
    const header = new Uint8Array(await fileData.slice(0, 32).arrayBuffer());
    const lz4Header = parseLz4FrameHeader(header);
    // IMPORTANTE: forzamos descompresión en el host (lz4=false para el envío).
    // Enviar comprimido vs descomprimido escribe EXACTAMENTE los mismos bytes
    // en la partición (el equipo descomprime del otro lado) — comprimido solo
    // es más rápido. La ruta de envío comprimido no está verificada contra
    // hardware, así que mientras depuramos usamos la descompresión probada,
    // que no cambia la validez del firmware escrito.
    const lz4 = false;

    const sequences: Lz4Sequence[] = [];
    for await (const seq of lz4Sequences(fileData, lz4Header, this._flashSequence * this._flashPacketSize)) {
      sequences.push(seq);
    }

    const progress = { sent: 0, total: lz4Header.contentSize, lastPct: -1 };

    // Cuando toca descomprimir en el navegador, se hace en un Web Worker
    // (hilo aparte) con una secuencia de adelanto: mientras el hilo
    // principal está ocupado enviando la secuencia actual por el puerto
    // serial (esperando los ACK del equipo, que es la parte lenta), el
    // worker ya está descomprimiendo la SIGUIENTE en paralelo — así los
    // dos tiempos se solapan en vez de sumarse uno después del otro.
    const worker = lz4 || sequences.length === 0 ? null : (this._lz4Worker ??= new Lz4DecompressClient());

    // Cola de P descompresiones en vuelo: con P=2 el worker mantiene 2
    // secuencias descomprimidas adelante mientras el hilo principal espera
    // los ACK del puerto. Ocupa ~2×RAM de secuencia (2 × ~100 MB) pero
    // garantiza que la descompresión nunca se quede detrás del serial.
    const PREFETCH = 2;
    const ready: Promise<Uint8Array>[] = [];
    const schedule = async (i: number) => {
      if (i >= sequences.length || !worker) return;
      ready.push(worker.decompress(await sequences[i]!.data.arrayBuffer(), lz4Header.blockMaxSize));
    };
    for (let i = 0; i < Math.min(PREFETCH, sequences.length); i++) await schedule(i);

    for (let sequenceIndex = 0; sequenceIndex < sequences.length; sequenceIndex++) {
      const { decompressedSize } = sequences[sequenceIndex]!;
      let data: Blob;
      const isLastSequence = sequenceIndex === sequences.length - 1;

      if (worker) {
        const decompressedBytes = await ready.shift()!;
        if (decompressedBytes.byteLength !== decompressedSize) {
          throw new Error(`Tamaño descomprimido esperado: ${decompressedSize}, recibido: ${decompressedBytes.byteLength}`);
        }
        data = new Blob([decompressedBytes as Uint8Array<ArrayBuffer>]);
        await schedule(sequenceIndex + PREFETCH);
      } else {
        data = sequences[sequenceIndex]!.data;
      }

      await this._sendFileSequence(data, decompressedSize, binaryType, deviceType, fileIdentifier, isLastSequence, lz4, progress);
    }
  }

  /**
   * Flashea un archivo, detectando automáticamente si es .lz4.
   *
   * IMPORTANTE: NO abre ni cierra sesión, y NO anuncia el total de bytes —
   * eso se hace UNA sola vez para todo el lote (suma de los tamaños
   * DESCOMPRIMIDOS de cada archivo interno, sin el .pit — ver nota en
   * odin-flash-tool.tsx) antes de empezar a enviar nada. Igual que odin4:
   * una sola Begin Session + un solo "total bytes" al principio, y después
   * las transferencias de cada partición dentro de esa misma sesión — NO
   * un ciclo Begin/End Session por archivo. Repetir Begin/End Session por
   * cada archivo (lo que se intentó antes) interrumpe la verificación del
   * binario a mitad de camino y el bootloader lo rechaza como "Custom
   * Binary Blocked", aunque el archivo en sí esté bien.
   */
  async flashFile(fileData: Blob, binaryType: EntryBinaryType, deviceType: number, fileIdentifier: number, expectedFileSize?: number) {
    // Safety check: si el PIT nos dice el tamaño que espera esa partición y el
    // archivo (descomprimido) no le pega ni en orden de magnitud, casi seguro
    // es firmware del modelo equivocado. Lo advertimos fuerte, no bloqueamos.
    const header = new Uint8Array(await fileData.slice(0, 32).arrayBuffer());
    let writeSize = fileData.size;
    if (isLz4Frame(header)) {
      const lz4Header = parseLz4FrameHeader(header as Uint8Array<ArrayBuffer>);
      writeSize = lz4Header.contentSize;
    }
    if (expectedFileSize && expectedFileSize > 0 && Math.abs(writeSize - expectedFileSize) / expectedFileSize > 0.5) {
      this.log(`   ⚠️ La partición espera ~${(expectedFileSize / 1048576).toFixed(1)} MB pero el archivo da ${(writeSize / 1048576).toFixed(1)} MB.`, 'warn');
      this.log('   ¿Es del modelo correcto? Con esta diferencia el binario casi seguro NO corresponde.', 'warn');
    }
    if (isLz4Frame(header)) {
      const lz4Header = parseLz4FrameHeader(header as Uint8Array<ArrayBuffer>);
      this.log(`   📦 ${(lz4Header.contentSize / 1048576).toFixed(1)} MB (comprimido: ${(fileData.size / 1048576).toFixed(1)} MB)`, 'info');
      await this.sendLz4File(fileData, binaryType, deviceType, fileIdentifier);
    } else {
      this.log(`   📦 ${(fileData.size / 1048576).toFixed(1)} MB`, 'info');
      await this.sendFile(fileData, binaryType, deviceType, fileIdentifier);
    }
    this.log('   ✅ enviado', 'ok');
  }

  /**
   * Un tramo (máx. 30 MiB) tal como lo manda odin4:
   *   66/0 → 66/2 <real redondeado a 128 KiB> → paquetes de 1 MiB (el último
   *   relleno con ceros), cada uno con ACK [0, índice] → 66/3 con el tamaño
   *   REAL exacto (sin redondear) y endOfFile=1 solo en el último tramo.
   */
  private async _sendFileSequence(
    sequenceData: Blob, realSize: number, binaryType: EntryBinaryType, deviceType: number,
    fileIdentifier: number, isLastSequence: boolean, lz4: boolean,
    progress?: { sent: number; total: number; lastPct: number },
  ) {
    const pkt = this._flashPacketSize;

    let alignedSize = realSize;
    if (alignedSize % SEQUENCE_ALIGNMENT !== 0) alignedSize += SEQUENCE_ALIGNMENT - (alignedSize % SEQUENCE_ALIGNMENT);
    if (alignedSize === 0) alignedSize = SEQUENCE_ALIGNMENT;

    await this.sendPacket(new FileTransferPacket(lz4 ? FileTransferRequest.Lz4Flash : FileTransferRequest.Flash), undefined, this._flashTimeout);
    await this.receivePacket(FileTransferResponse, this._flashTimeout, undefined, 'abrir transferencia');

    await this.sendPacket(new FlashPartFileTransferPacket(alignedSize, lz4), undefined, this._flashTimeout);
    await this.receivePacket(FileTransferResponse, this._flashTimeout, undefined, 'pedir secuencia (FlashPart)');

    const partCount = Math.ceil(alignedSize / pkt);

    for (let filePartIndex = 0; filePartIndex < partCount; filePartIndex++) {
      const startOffset = filePartIndex * pkt;
      // slice más allá del final del blob devuelve vacío; SendFilePartPacket
      // rellena con ceros hasta pkt, igual que odin4.
      const partData = new Uint8Array(await sequenceData.slice(startOffset, startOffset + pkt).arrayBuffer());

      await this.sendPacket(
        new SendFilePartPacket(partData, pkt),
        filePartIndex === 0 ? EmptySendKind.None : EmptySendKind.Before,
        this._flashTimeout,
      );

      const resp = await this.receivePacket(SendFilePartResponse, this._flashTimeout, undefined, `parte ${filePartIndex}/${partCount}`);
      if (resp.partIndex !== filePartIndex) {
        throw new Error(`Índice de parte esperado: ${filePartIndex}, recibido: ${resp.partIndex}`);
      }

      if (progress) {
        progress.sent += partData.length;
        const pct = progress.total > 0 ? Math.floor((progress.sent / progress.total) * 100) : 0;
        if (pct >= progress.lastPct + 10 || filePartIndex === partCount - 1) {
          progress.lastPct = pct;
          this.options.onProgress?.(Math.min(pct, 100) / 100);
          this.log(`      ${Math.min(progress.sent, progress.total) / 1048576 | 0}/${(progress.total / 1048576) | 0} MB (${Math.min(pct, 100)}%)`, 'info');
        }
      }
    }

    // El end packet reporta el tamaño real exacto del tramo (odin4 manda,
    // p. ej., 0x1dd02d4 en el último tramo de userdata: sin redondear).
    const endPacket = binaryType === EntryBinaryType.CommunicationProcessor
      ? new EndModemFileTransferPacket(realSize, binaryType, deviceType, isLastSequence, lz4)
      : new EndPhoneFileTransferPacket(realSize, binaryType, deviceType, fileIdentifier, isLastSequence, lz4);

    await this.sendPacket(endPacket, EmptySendKind.BeforeAndAfter, this._flashTimeout);
    await this.receivePacket(FileTransferResponse, this._flashTimeout, undefined, `cerrar secuencia (real=${realSize}, last=${isLastSequence})`);
  }

  private _hex(data: Uint8Array): string {
    return Array.from(data.subarray(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  }

  async sendPacket(packet: OutboundPacket, emptySendKind?: EmptySendKind, timeout?: number) {
    packet.pack();
    emptySendKind = emptySendKind ?? EmptySendKind.After;

    if ((emptySendKind & EmptySendKind.Before) !== 0) {
      await this.transport.send(new Uint8Array(), EMPTY_TRANSFER_TIMEOUT).catch(() => {});
    }
    await this.transport.send(packet.data, timeout ?? this.options.timeout);
    if ((emptySendKind & EmptySendKind.After) !== 0) {
      await this.transport.send(new Uint8Array(), EMPTY_TRANSFER_TIMEOUT).catch(() => {});
    }
  }

  async receivePacket<T extends InboundPacket>(Packet: { new (): T }, timeout?: number, size?: number, context?: string): Promise<T> {
    const packet = new Packet();
    const data = await this.transport.receive(size ?? packet.size, timeout ?? this.options.timeout);

    if (data.byteLength !== packet.size && !packet.sizeVariable) {
      this.log(`   ⚠️ tamaño inesperado${context ? ` (${context})` : ''}: esperaba ${packet.size}, llegó ${data.byteLength} — bytes: ${this._hex(data)}`, 'error');
      throw new Error('incorrect size received');
    }
    packet.data = data;
    packet.receivedSize = data.byteLength;
    try {
      await packet.unpack();
    } catch (e) {
      // Diagnóstico: volcar los bytes crudos que llegaron del equipo para
      // distinguir un FAIL/NAK real (el equipo rechaza) de una
      // desincronización del stream (bytes corridos/basura).
      this.log(`   ⚠️ respuesta inesperada${context ? ` (${context})` : ''}: ${this._hex(data)}`, 'error');
      throw e;
    }
    return packet;
  }

  async _emptyReceive(timeout?: number) {
    await this.transport.emptyReceive(1024, timeout ?? EMPTY_TRANSFER_TIMEOUT);
  }
}
