// Transporte Odin sobre Web Serial API (puerto COM) — NO requiere cambiar el driver (sin Zadig/WinUSB).
// Imita la interfaz USBDevice que usa OdinDevice (transferOut/transferIn/open/close/reset)
// reutilizando toda la lógica del protocolo de la librería.
import { OdinDevice, DeviceOptions } from 'libmjolnir';

/** Adaptador que expone la API de USBDevice pero por debajo usa un SerialPort */
class SerialUsbAdapter {
  port: any;
  writer: any;
  reader: any;
  buffer = new Uint8Array(0);
  closed = false;

  // Campos "falsos" para compatibilidad con el código que inspecciona el USBDevice
  productName = 'SAMSUNG USB (Serial)';
  vendorId = 0x04e8;
  productId = 0;

  constructor (port: any) {
    this.port = port;
    const info = port.getInfo?.() || {};
    this.vendorId = info.usbVendorId ?? 0x04e8;
    this.productId = info.usbProductId ?? 0;
  }

  async open () {
    await this.port.open({ baudRate: 115200, bufferSize: 4096 });
    // CDC-ACM (Gadget Serial de Samsung): el equipo no responde hasta que el host
    // asserta DTR. Sin esto el handshake ODIN se envía pero nunca llega "LOKE".
    try {
      await this.port.setSignals({ dataTerminalReady: true });
    } catch { /* algunos drivers no lo soportan; se intenta igual */ }
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this._readLoop();
  }

  // Bucle de lectura en segundo plano: acumula todo lo que llega en this.buffer
  private async _readLoop () {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) this._append(value);
      }
    } catch { /* puerto cerrado */ }
  }

  private _append (chunk: Uint8Array) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  // Imita USBDevice.transferOut
  async transferOut (_endpoint: number, data: Uint8Array) {
    if (data && data.length) {
      await this.writer.write(data);
    }
    return { status: 'ok', bytesWritten: data ? data.length : 0 };
  }

  // Imita USBDevice.transferIn: devuelve exactamente `length` bytes del buffer serie.
  // Atómico: solo recorta el buffer en el mismo instante en que resuelve (no roba bytes
  // si expira), y tiene su propio deadline para no dejar pollers colgados.
  transferIn (_endpoint: number, length: number): Promise<{ status: string, data: DataView }> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const check = () => {
        if (this.buffer.length >= length) {
          const out = this.buffer.slice(0, length);
          this.buffer = this.buffer.slice(length);
          return resolve({ status: 'ok', data: new DataView(out.slice().buffer) });
        }
        if (this.closed) return reject(new Error('serial port closed'));
        if (Date.now() > deadline) return reject(new Error('serial read timeout'));
        setTimeout(check, 3);
      };
      check();
    });
  }

  reset () { return Promise.resolve(); } // Serial no tiene reset de USB

  async close () {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* */ }
    try { this.reader?.releaseLock(); } catch { /* */ }
    try { await this.writer?.close(); } catch { /* */ }
    try { this.writer?.releaseLock?.(); } catch { /* */ }
    try { await this.port.close(); } catch { /* */ }
  }
}

/** OdinDevice que se comunica por puerto serie en vez de por WebUSB */
export class SerialOdinDevice extends OdinDevice {
  _adapter: SerialUsbAdapter;
  _port: any;

  constructor (port: any, options?: Partial<DeviceOptions>) {
    const adapter = new SerialUsbAdapter(port);
    super(adapter as unknown as USBDevice, options);
    this._adapter = adapter;
    this._port = port;
  }

  // Sustituye la inicialización USB (claim de interfaz/endpoints) por abrir el puerto serie
  async initialize () {
    await this._adapter.open();
    // Endpoints ficticios: el adaptador los ignora
    this.outEndpointNum = 1;
    this.inEndpointNum = 1;
    return this.handshake();
  }

  // Handshake para serial: lee EXACTAMENTE 4 bytes ("LOKE"), no 7 como la versión USB.
  // Por serial no hay límites de paquete, así que pedir 7 bytes se cuelga (solo llegan 4).
  async handshake () {
    this.deviceOptions.logging && console.log('🤝 Handshake ODIN/LOKE (serial)...');
    await this._adapter.transferOut(1, new TextEncoder().encode('ODIN'));
    const resp = await this._adapter.transferIn(1, 4);
    const str = new TextDecoder().decode(new Uint8Array(resp.data.buffer));
    this.deviceOptions.logging && console.log(`sent: ODIN → recibido: ${str}`);
    if (str !== 'LOKE') throw new Error('handshake challenge mismatch (serial): ' + JSON.stringify(str));
  }

  // En serial no existen los "zero-length packets" de USB: desactiva los empty transfers
  // (evita esperas de 100ms y que un empty-receive robe bytes del siguiente paquete).
  async _emptySend () { /* no-op en serial */ }
  async _emptyReceive () { /* no-op en serial */ }

  onDisconnect (callback: () => void) {
    const nav: any = navigator;
    if (nav.serial?.addEventListener) {
      const handler = (e: any) => { if (e.target === this._port) callback(); };
      nav.serial.addEventListener('disconnect', handler);
    }
  }
}

/** Pide/recupera un puerto serie Samsung y devuelve un SerialOdinDevice listo para initialize() */
export async function requestSerialDevice (options?: Partial<DeviceOptions>): Promise<SerialOdinDevice> {
  const nav: any = navigator;
  if (!nav.serial) {
    throw new Error('Este navegador no soporta Web Serial (usa Chrome o Edge de escritorio).');
  }
  const SAMSUNG = 0x04e8;
  // 1) ¿Hay un puerto Samsung ya autorizado?
  const existing = (await nav.serial.getPorts()).find((p: any) => p.getInfo?.().usbVendorId === SAMSUNG);
  // 2) Si no, abre el selector de puertos filtrando por Samsung
  const port = existing || await nav.serial.requestPort({ filters: [{ usbVendorId: SAMSUNG }] });
  return new SerialOdinDevice(port, options);
}
