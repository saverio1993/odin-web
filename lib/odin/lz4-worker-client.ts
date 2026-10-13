// ─────────────────────────────────────────────────────────────────
// Cliente del worker de descompresión LZ4 (/public/odin-lz4-worker.js —
// ver ese archivo para el porqué va como script estático y no como módulo
// bundleado). Esta clase solo maneja el ida-y-vuelta de mensajes con IDs.
// ─────────────────────────────────────────────────────────────────

interface Lz4WorkerRequest {
  id: number;
  data: ArrayBuffer;
  blockMaxSize: number;
}

type Lz4WorkerResponse =
  | { id: number; data: ArrayBuffer }
  | { id: number; error: string };

export class Lz4DecompressClient {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker('/odin-lz4-worker.js');
    this.worker.onmessage = (e: MessageEvent<Lz4WorkerResponse>) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg) p.reject(new Error(msg.error));
      else p.resolve(new Uint8Array(msg.data));
    };
    this.worker.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new Error(e.message || 'lz4 worker error'));
      this.pending.clear();
    };
  }

  decompress(data: ArrayBuffer, blockMaxSize: number): Promise<Uint8Array> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: Lz4WorkerRequest = { id, data, blockMaxSize };
      this.worker.postMessage(req, [data]);
    });
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}
