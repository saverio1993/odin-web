// ─────────────────────────────────────────────────────────────────
// Transporte WebSerial para el protocolo Odin — port fiel de libmjolnir
// (MIT, LineageOS). Clave: receive(length) exige exactamente `length`
// bytes (no 1024 a lo loco), y el puerto se abre con DTR activado
// (los CDC-ACM como este no procesan datos hasta que DTR está en alto).
// ─────────────────────────────────────────────────────────────────

export interface OdinTransport {
  connect(timeout: number): Promise<void>;
  send(data: Uint8Array, timeout: number): Promise<void>;
  receive(length: number, timeout: number): Promise<Uint8Array>;
  emptyReceive(length: number, timeout: number): Promise<void>;
  reset(timeout: number): Promise<void>;
  close(timeout: number): Promise<void>;
  onDisconnect(callback: () => void): void;
}

function timeoutPromise<T>(promise: Promise<T>, reason: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const BAUD_RATE = 115200;
// El equipo trata CADA envío USB como un paquete: si un write() sale partido,
// toma cada trozo como un paquete aparte y los datos quedan corridos (PIT
// rechazado con ffffffff en 65/3, o uh.bin rechazado con fffffffb al cerrar
// la secuencia). Chrome escribe a través de un buffer circular de
// `bufferSize` bytes y corta el write() donde el buffer da la vuelta
// (captura web A165M: 992876 + 55700 en vez de 1 MiB). Por eso send() lleva
// la cuenta de la posición y, antes de un write() que cruzaría el final,
// abre un writable nuevo (buffer vacío, posición 0). Así cada paquete sale
// en un solo bulk, igual que odin4.
const SERIAL_BUFFER_SIZE = 8 * 1048576;

export class WebSerialTransport implements OdinTransport {
  readonly port: SerialPort;

  private _reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private _writer: WritableStreamDefaultWriter<Uint8Array> | undefined;

  private _chunks: Uint8Array[] = [];
  private _chunkOffset = 0;
  private _available = 0;

  private _pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  /** Bytes escritos en el buffer circular del writable actual. */
  private _writePos = 0;

  constructor(port: SerialPort) {
    this.port = port;
  }

  async connect(timeout: number) {
    await timeoutPromise(
      this.port.open({ baudRate: BAUD_RATE, bufferSize: SERIAL_BUFFER_SIZE }),
      '[connect] unable to open serial port',
      timeout,
    );

    try {
      await this.port.setSignals({ dataTerminalReady: true });
    } catch {
      // best-effort; no todas las plataformas implementan setSignals
    }

    if (!this.port.readable || !this.port.writable) {
      throw new Error('serial port did not expose readable/writable streams');
    }

    this._reader = this.port.readable.getReader();
    this._writer = this.port.writable.getWriter();
    this._writePos = 0;
  }

  async send(data: Uint8Array, timeout: number) {
    if (!this._writer) throw new Error('serial port is not open');
    if (data.length === 0) return; // odin4 no manda envíos vacíos
    if (this._writePos + data.length > SERIAL_BUFFER_SIZE) await this._freshWriter(timeout);
    await timeoutPromise(this._writer.write(data), '[device] unable to send packet', timeout);
    this._writePos += data.length;
  }

  /** Cierra el writable (espera a que se envíe todo) y abre otro con el buffer vacío. */
  private async _freshWriter(timeout: number) {
    const old = this.port.writable;
    await timeoutPromise(this._writer!.close(), '[device] unable to flush serial writer', timeout);
    this._writer!.releaseLock();
    let writable = this.port.writable;
    for (let i = 0; i < 50 && (!writable || writable === old); i++) {
      await new Promise((r) => setTimeout(r, 10));
      writable = this.port.writable;
    }
    if (!writable || writable === old) throw new Error('serial port did not expose a new writable stream');
    this._writer = writable.getWriter();
    this._writePos = 0;
  }

  async receive(length: number, timeout: number): Promise<Uint8Array> {
    while (this._available < length) {
      this._append(await this._readChunk(timeout));
    }

    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const head = this._chunks[0]!;
      const available = head.length - this._chunkOffset;
      const take = Math.min(available, length - written);
      out.set(head.subarray(this._chunkOffset, this._chunkOffset + take), written);
      written += take;

      if (take === available) {
        this._chunks.shift();
        this._chunkOffset = 0;
      } else {
        this._chunkOffset += take;
      }
    }
    this._available -= length;
    return out;
  }

  async emptyReceive(_length: number, timeout: number) {
    try {
      this._append(await this._readChunk(timeout));
    } catch {
      // drenado abandonado, no pasa nada
    }
  }

  reset(): Promise<void> {
    return Promise.resolve();
  }

  async close(timeout: number) {
    if (this._reader) {
      try { await this._reader.cancel(); } catch { /* noop */ }
      this._reader.releaseLock();
      this._reader = undefined;
    }
    if (this._writer) {
      try { this._writer.releaseLock(); } catch { /* noop */ }
      this._writer = undefined;
    }
    this._pendingRead = undefined;
    this._chunks = [];
    this._chunkOffset = 0;
    this._available = 0;

    await timeoutPromise(this.port.close(), '[close] unable to close serial port', timeout);
  }

  onDisconnect(callback: () => void) {
    const handler = (event: Event) => {
      if ((event as any).target === this.port) {
        callback();
        navigator.serial.removeEventListener('disconnect', handler);
      }
    };
    navigator.serial.addEventListener('disconnect', handler);
  }

  private async _readChunk(timeout: number): Promise<Uint8Array> {
    if (!this._reader) throw new Error('serial port is not open');

    const read = this._pendingRead ?? this._reader.read();
    this._pendingRead = read;

    const result = await timeoutPromise(read, '[device] timed out waiting for serial data', timeout);
    this._pendingRead = undefined;

    if (result.done) throw new Error('serial stream closed');
    return result.value!;
  }

  private _append(chunk: Uint8Array) {
    if (chunk.length === 0) return;
    this._chunks.push(chunk);
    this._available += chunk.length;
  }
}
