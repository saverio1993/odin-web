// Web Worker: descomprime secuencias LZ4 en un hilo aparte del principal,
// para que ese hilo quede libre para el I/O del puerto serial (cada parte
// enviada espera un ACK del equipo) mientras se descomprime la SIGUIENTE
// secuencia en paralelo — así los dos tiempos se solapan en vez de sumarse.
//
// Va en /public (no pasa por el bundler de Next.js) porque el patrón
// `new Worker(new URL('./x.ts', import.meta.url))` no queda separado en su
// propio chunk con la config de webpack de este proyecto — el worker
// terminaba empaquetado dentro del bundle principal de la página en vez de
// como un script cargable aparte, y `new Worker(...)` fallaba en el
// navegador. Sirviéndolo como archivo estático no depende de eso.
//
// Es una copia en JS plano de la misma lógica de
// apps/web/lib/odin/lz4.ts (decompressLz4Block / decompressLz4Sequence) —
// si se cambia una, hay que cambiar la otra.

function decompressLz4Block(src, maxDecompressedSize) {
  const dst = new Uint8Array(maxDecompressedSize);
  let srcIndex = 0;
  let dstIndex = 0;

  while (srcIndex < src.length) {
    const token = src[srcIndex++];

    let literalLength = token >> 4;
    if (literalLength === 15) {
      let lengthByte;
      do {
        lengthByte = src[srcIndex++];
        literalLength += lengthByte;
      } while (lengthByte === 255);
    }

    if (dstIndex + literalLength > dst.length) throw new Error('LZ4 block exceeds max decompressed size');

    dst.set(src.subarray(srcIndex, srcIndex + literalLength), dstIndex);
    srcIndex += literalLength;
    dstIndex += literalLength;

    if (srcIndex >= src.length) break;

    const offset = src[srcIndex] | (src[srcIndex + 1] << 8);
    srcIndex += 2;

    if (offset === 0 || offset > dstIndex) throw new Error('Invalid LZ4 block match offset');

    let matchLength = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let lengthByte;
      do {
        lengthByte = src[srcIndex++];
        matchLength += lengthByte;
      } while (lengthByte === 255);
    }

    if (dstIndex + matchLength > dst.length) throw new Error('LZ4 block exceeds max decompressed size');

    // IMPORTANTE: LZ4 usa el caso offset<matchLength para RLE (por ejemplo
    // rellenar '0x00 0x00 0x00...' repitiendo 1 byte N veces). En ese caso
    // la copia DEBE leer los bytes que acaba de escribir en la misma pasada
    // — por eso va el loop byte-por-byte. copyWithin tiene semántica de
    // memmove: toma el rango source como snapshot ANTES de escribir y
    // termina leyendo ceros no inicializados al pasar el puntero,
    // corrompiendo la imagen (bug introducido en commit e044c61,
    // confirmado con up_param.bin.lz4). Solo se usa copyWithin cuando el
    // rango source NO solapa con el destino, que es la mitad "rápida".
    if (offset >= matchLength) {
      dst.copyWithin(dstIndex, dstIndex - offset, dstIndex - offset + matchLength);
      dstIndex += matchLength;
    } else {
      let matchIndex = dstIndex - offset;
      for (let i = 0; i < matchLength; i++) dst[dstIndex++] = dst[matchIndex++];
    }
  }

  return dst.subarray(0, dstIndex);
}

function decompressLz4Sequence(sequenceData, blockMaxSize) {
  const view = new DataView(sequenceData.buffer, sequenceData.byteOffset, sequenceData.byteLength);
  const blocks = [];
  let offset = 0;
  let totalSize = 0;

  while (offset + 4 <= sequenceData.length) {
    const blockSize = view.getUint32(offset, true);
    offset += 4;

    const dataSize = blockSize & 0x7fffffff;
    const data = sequenceData.subarray(offset, offset + dataSize);
    offset += dataSize;

    const isCompressed = (blockSize & 0x80000000) === 0;
    const block = isCompressed ? decompressLz4Block(data, blockMaxSize) : data;

    blocks.push(block);
    totalSize += block.length;
  }

  const result = new Uint8Array(totalSize);
  let resultOffset = 0;
  for (const block of blocks) {
    result.set(block, resultOffset);
    resultOffset += block.length;
  }
  return result;
}

self.onmessage = (e) => {
  const { id, data, blockMaxSize } = e.data;
  try {
    const result = decompressLz4Sequence(new Uint8Array(data), blockMaxSize);
    self.postMessage({ id, data: result.buffer }, [result.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
