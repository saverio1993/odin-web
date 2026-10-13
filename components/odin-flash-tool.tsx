'use client';

// Herramienta de flasheo tipo Odin: carga BL/AP/CP/CSC/DATA desde una carpeta
// local (File System Access API), autocompleta el set al elegir un archivo,
// recuerda la carpeta preferida y guarda un historial de versiones — todo
// queda en el navegador del técnico, nada se sube a la academia.
//
// El protocolo Odin en sí (apps/web/lib/odin/*) es un port de libmjolnir
// (github.com/lineageos-infra/libmjolnir, MIT, LineageOS) — la librería que
// ya resuelve exactamente este caso (flashear Samsung desde el navegador).
import { useCallback, useEffect, useRef, useState } from 'react';
import { OdinDevice } from '@/lib/odin/device';
import { WebSerialTransport } from '@/lib/odin/transport';
import { PitData, PitEntry } from '@/lib/odin/pit';
import { verifyTarMd5 } from '@/lib/odin/md5';
import { isLz4Frame, parseLz4FrameHeader } from '@/lib/odin/lz4';
import {
  ODIN_SLOTS,
  matchFirmwareSet,
    listFirmwareFiles,
    listTarEntries,
    stripCompressionSuffix,
    type TarEntry,
    loadFolderHandle,
    saveFolderHandle,
    loadHistory,
    pushHistory,
    inferModelFromName,
    inferBitFromName,
    isDestructiveCsc,
    type OdinSlot,
    type OdinSlotFile,
    type OdinHistoryEntry,
  } from '@/lib/odin-firmware-set';

type LogKind = 'info' | 'ok' | 'warn' | 'error' | 'title';
const LOG_COLOR: Record<LogKind, string> = {
  info: 'text-sky-300', ok: 'text-emerald-400', warn: 'text-amber-400',
  error: 'text-red-400', title: 'text-orange-400 font-black',
};
const T = () => new Date().toLocaleTimeString('es', { hour12: false });

/** Bytes que se escriben en el equipo: el tamaño descomprimido si es .lz4. */
async function writeSizeOf(blob: Blob): Promise<number> {
  const header = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  return isLz4Frame(header) ? parseLz4FrameHeader(header).contentSize : blob.size;
}

const SLOT_LABEL: Record<OdinSlot, string> = {
  BL: 'BL', AP: 'AP', CP: 'CP', CSC: 'CSC', DATA: 'DATA',
};

interface SlotState { file: OdinSlotFile | null; enabled: boolean; }

export function OdinFlashTool() {
  const [supported, setSupported] = useState(true);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [slots, setSlots] = useState<Record<OdinSlot, SlotState>>({
    BL: { file: null, enabled: true }, AP: { file: null, enabled: true },
    CP: { file: null, enabled: true }, CSC: { file: null, enabled: true },
    DATA: { file: null, enabled: false },
  });
  const [history, setHistory] = useState<OdinHistoryEntry[]>([]);
  const [selectedHistory, setSelectedHistory] = useState('');
  const [reboot, setReboot] = useState(true);
  const [checkMd5, setCheckMd5] = useState(true);
  const [skipUserdata, setSkipUserdata] = useState(true);
  const [writePit, setWritePit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState('');
  const [progress, setProgress] = useState<number>(0);
  const [pit, setPit] = useState<PitEntry[] | null>(null);
  const [logs, setLogs] = useState<{ t: string; text: string; kind: LogKind }[]>([]);
  const [eraseToast, setEraseToast] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);

  const log = useCallback((text: string, kind: LogKind = 'info') => {
    setLogs((prev) => [...prev, { t: T(), text, kind }]);
  }, []);
  const clear = useCallback(() => setLogs([{ t: T(), kind: 'info', text: '=== Consola lista ===' }]), []);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && 'showDirectoryPicker' in window && 'serial' in navigator);
    setLogs([{ t: T(), kind: 'info', text: 'Herramienta de flasheo lista — carga el archivo BL/AP y se autocompleta el set.' }]);
    loadHistory().then(setHistory).catch(() => {});
    loadFolderHandle().then(async (handle) => {
      if (!handle) return;
      try {
        const perm = await (handle as any).queryPermission?.({ mode: 'read' });
        if (perm === 'granted' || (await (handle as any).requestPermission?.({ mode: 'read' })) === 'granted') {
          setDirHandle(handle);
          setFolderName(handle.name);
          log(`📁 Carpeta recordada: ${handle.name}`, 'info');
        }
      } catch { /* el usuario deberá elegir la carpeta de nuevo */ }
    });
  }, [log]);

  useEffect(() => { consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight }); }, [logs]);

  const chooseFolder = useCallback(async () => {
    try {
      const handle = await (window as any).showDirectoryPicker({ id: 'odin-firmware', mode: 'read' });
      setDirHandle(handle);
      setFolderName(handle.name);
      await saveFolderHandle(handle);
      log(`📁 Carpeta preconfigurada: ${handle.name}`, 'ok');
    } catch {
      log('Se canceló la selección de carpeta.', 'warn');
    }
  }, [log]);

  // Al elegir UN archivo (de cualquier slot), se escanea la carpeta completa
  // y se autocompletan los demás slots — igual que hace la herramienta de Samsung.
  const autofillFromFolder = useCallback(async () => {
    if (!dirHandle) return;
    try {
      const files = await listFirmwareFiles(dirHandle);
      const matched = matchFirmwareSet(files);
      setSlots((prev) => {
        const next = { ...prev };
        for (const slot of ODIN_SLOTS) {
          if (matched[slot]) next[slot] = { file: matched[slot]!, enabled: next[slot].enabled || slot !== 'DATA' };
        }
        return next;
      });
      const found = ODIN_SLOTS.filter((s) => matched[s]);
      log(`🔎 Autocompletado desde la carpeta: ${found.join(', ') || 'no se reconoció ningún archivo'}`, found.length ? 'ok' : 'warn');
    } catch (e) {
      log(`No se pudo leer la carpeta: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    }
  }, [dirHandle, log]);

  // En cuanto hay carpeta configurada (recién elegida o recordada de antes),
  // se escanea y se llenan los slots solos — sin que haga falta tocar "Open".
  useEffect(() => {
    if (dirHandle) void autofillFromFolder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirHandle]);

  // Selección manual de UN archivo para un slot — no hay forma estándar de
  // navegador de obtener la carpeta contenedora de un archivo suelto (no
  // existe "getParent()" en la File System Access API), así que esto solo
  // llena ese slot. Para autocompletar el set completo, usa "Preconfigurar
  // carpeta": eso sí escanea y llena todo automáticamente (ver efecto arriba).
  const openSlotFile = useCallback(async (slot: OdinSlot) => {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        types: [{ description: 'Firmware', accept: { 'application/octet-stream': ['.tar', '.md5', '.img', '.bin'] } }],
      });
      const file: File = await handle.getFile();
      setSlots((prev) => ({ ...prev, [slot]: { file: { name: file.name, size: file.size, handle }, enabled: true } }));
      log(`${slot}: ${file.name} (${(file.size / 1048576).toFixed(1)} MB)`, 'info');
    } catch {
      log('Se canceló la selección de archivo.', 'warn');
    }
  }, [log]);

  const toggleSlot = (slot: OdinSlot) =>
    setSlots((prev) => ({ ...prev, [slot]: { ...prev[slot], enabled: !prev[slot].enabled } }));

  const resetAll = useCallback(() => {
    setSlots({
      BL: { file: null, enabled: true }, AP: { file: null, enabled: true },
      CP: { file: null, enabled: true }, CSC: { file: null, enabled: true },
      DATA: { file: null, enabled: false },
    });
    setProgressLabel('');
    setProgress(0);
    clear();
  }, [clear]);

  const applyHistoryEntry = useCallback(async (id: string) => {
    setSelectedHistory(id);
    const entry = history.find((h) => h.id === id);
    if (!entry || !dirHandle) return;
    await autofillFromFolder();
    log(`📜 Historial: "${entry.label}" — vuelve a confirmar los archivos cargados.`, 'info');
  }, [history, dirHandle, autofillFromFolder, log]);

  // Abre el puerto, hace el handshake y Begin Session. Devuelve el OdinDevice
  // ya listo, o null si algo falló (ya quedó logueado el motivo).
  const connectDevice = useCallback(async (): Promise<OdinDevice | null> => {
    log('🔑 Selecciona "Samsung Mobile USB Modem" / COM port...', 'info');
    log('   Si el teléfono muestra varios puertos iguales (#1, #2...), prueba con el #2.', 'info');
    const port = await navigator.serial.requestPort();
    const device = new OdinDevice(new WebSerialTransport(port), { log, onProgress: setProgress });
    try {
      await device.initialize();
      await device.beginSession();
      return device;
    } catch (e) {
      log(`❌ ${e instanceof Error ? e.message : String(e)}`, 'error');
      await device.close().catch(() => {});
      return null;
    }
  }, [log]);

  // Conecta, ejecuta una acción sobre el equipo y siempre cierra el puerto.
  const runOnDevice = useCallback(async (label: string, action: (device: OdinDevice) => Promise<void>) => {
    setBusy(true);
    let device: OdinDevice | null = null;
    try {
      device = await connectDevice();
      if (!device) return;
      await action(device);
    } catch (e) {
      log(`❌ Error ${label}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      await device?.close().catch(() => {});
      setBusy(false);
    }
  }, [connectDevice, log]);

  // Lee la tabla de particiones del equipo — solo lectura, sin tocar nada.
  const readPitOnly = useCallback(() => runOnDevice('leyendo PIT', async (device) => {
    setPit(null);
    const pitData = await device.getPitData();
    setPit(pitData.entries.filter((e) => e.isFlashable));
    await device.endSession();
  }), [runOnDevice]);

  // Igual que leer el PIT, pero además lo descarga como archivo .pit.
  const savePit = useCallback(() => runOnDevice('guardando PIT', async (device) => {
    const pitData = await device.getPitData();
    setPit(pitData.entries.filter((e) => e.isFlashable));
    await device.endSession();
    const raw = device.pitRaw;
    if (!raw) return;
    const url = URL.createObjectURL(new Blob([raw as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `equipo_${new Date().toISOString().slice(0, 10)}.pit`;
    a.click();
    URL.revokeObjectURL(url);
    log(`💾 PIT guardado (${raw.length} bytes)`, 'ok');
  }), [runOnDevice, log]);

  // Borra userdata (factory reset) — función estándar del protocolo Odin.
  // Pide confirmación porque borra TODOS los datos del usuario (no toca FRP
  // ni ninguna cuenta).
  const eraseUserdata = useCallback(() => {
    if (!window.confirm('Esto borra TODOS los datos del usuario (factory reset). ¿Continuar?')) return;
    return runOnDevice('borrando userdata', async (device) => {
      log('🗑️ Borrando userdata (factory reset)...', 'warn');
      await device.eraseUserdata();
      log('✅ Userdata borrado', 'ok');
      setEraseToast(true);
      setTimeout(() => setEraseToast(false), 4000);
      log('🔄 Reiniciando a modo normal...', 'info');
      await device.endSession(true);
    });
  }, [runOnDevice, log]);

  // Saca el equipo del modo Download y lo arranca normal.
  const rebootDevice = useCallback(() => runOnDevice('reiniciando', async (device) => {
    await device.reboot();
    log('✅ Equipo reiniciado', 'ok');
  }), [runOnDevice, log]);

  // Solo handshake + sesión: confirma que el puerto y el equipo responden.
  const testConnection = useCallback(() => runOnDevice('probando conexión', async (device) => {
    log('✅ El equipo responde en modo Download', 'ok');
    await device.endSession();
  }), [runOnDevice, log]);

  const copyLog = useCallback(async () => {
    await navigator.clipboard.writeText(logs.map((l) => `${l.t} ${l.text}`).join('\n'));
    log('📋 Consola copiada al portapapeles', 'ok');
  }, [logs, log]);

  const flash = useCallback(async () => {
    const activeFiles: Partial<Record<OdinSlot, File>> = {};
    for (const slot of ODIN_SLOTS) {
      const s = slots[slot];
      if (s.enabled && s.file) activeFiles[slot] = await s.file.handle.getFile();
    }
    if (Object.keys(activeFiles).length === 0) {
      log('Selecciona al menos un archivo (BL, AP, CP, CSC o DATA).', 'warn');
      return;
    }

    // ── Validación de compatibilidad de modelo ──
    // Los nombres de firmware Samsung llevan el modelo (AP_SM-A546B_...).
    // Si mezclaste archivos de modelos distintos, el flasheo seguramente
    // escribe un binario que no corresponde y el equipo queda inválido.
    const models = new Set<string>();
    for (const f of Object.values(activeFiles)) {
      const m = inferModelFromName(f!.name);
      if (m) models.add(m);
    }
    if (models.size > 1) {
      log(`⚠️ Los archivos cargados parecen de modelos DISTINTOS: ${[...models].join(', ')}.`, 'error');
      log('   Revisa que TODOS sean del mismo modelo exacto antes de flashear. Flasheo cancelado.', 'error');
      return;
    }

    // ── Bit / anti-rollback ──
    // El equipo solo acepta un firmware cuyo bit sea >= al que ya tiene
    // fusionado. Si es menor, recibe todo bien pero lo rechaza al arrancar
    // y rebota a modo descarga ("An error has occurred..."). No lo podemos
    // leer del equipo, pero mostramos el bit del firmware para que el
    // técnico lo compare con el que ve en la pantalla de modo descarga.
    const bitInfo = inferBitFromName(Object.values(activeFiles)[0]!.name);
    if (bitInfo) {
      log(`🔢 Bit del firmware: ${bitInfo.bit} (versión ${bitInfo.version})`, 'title');
      log('   El equipo rechaza el firmware si su bit es MENOR al que ya tiene.', 'info');
      log('   Comparalo con el "Current Binary / SW REV" que muestra el modo descarga ANTES de flashear.', 'info');
    }

    // ── Advertencia si alguno borrará datos (CSC_ o DATA) ──
    const destructive = ODIN_SLOTS.filter((slot) => isDestructiveCsc(slot, activeFiles[slot]?.name));
    if (destructive.length > 0) {
      const names = destructive.map((s) => `${s}: ${activeFiles[s]?.name}`).join(' · ');
      const sure = window.confirm(
        `⚠️ Estos archivos BORRARÁN los datos del usuario (factory reset que afecta también a desbloqueo/DRM):\n\n${names}\n\n¿Continuar la escritura?`,
      );
      if (!sure) {
        log('Flasheo cancelado — contiene archivos que borran datos.', 'warn');
        return;
      }
    }

    setBusy(true); setProgressLabel('Verificando MD5...');
    let device: OdinDevice | null = null;
    let ok = false;
    try {
      // Verificar el MD5 de cada .tar.md5 ANTES de conectar al equipo — igual
      // que "Check MD5" en Odin.exe: detecta un archivo corrupto/mal
      // descargado sin arriesgarse a escribirlo a medias en el equipo.
      if (checkMd5) {
        for (const slot of ODIN_SLOTS) {
          const tarFile = activeFiles[slot];
          if (!tarFile || !/\.md5$/i.test(tarFile.name)) continue;
          log(`🔐 ${slot}: ${tarFile.name}`, 'title');
          const result = await verifyTarMd5(tarFile, log);
          if (result === false) {
            log(`❌ ${slot}: el MD5 no coincide — el archivo está corrupto o incompleto. Flasheo cancelado.`, 'error');
            setProgressLabel('MD5 inválido');
            return;
          }
        }
      }

      // Se abren los .tar ANTES de conectar: odin4 anuncia el total de bytes
      // y escribe el PIT del CSC antes de leer el PIT del equipo, así que el
      // contenido del lote tiene que conocerse de antemano.
      //
      // El total que se anuncia es la suma de los tamaños DESCOMPRIMIDOS de
      // cada archivo interno que se va a enviar, sin el .pit ni meta-data/.
      // Verificado contra la captura USB de odin4 (A065M): anunció
      // 0x285bfd2c8 = exactamente esa suma (y NO la suma de los .tar.md5).
      const lots: { slot: OdinSlot; entries: TarEntry[] }[] = [];
      let pitFile: Uint8Array | null = null;
      let totalBytes = 0;
      for (const slot of ODIN_SLOTS) {
        const tarFile = activeFiles[slot];
        if (!tarFile) continue;
        log(`── Abriendo ${slot}: ${tarFile.name} ──`, 'title');
        const inner = await listTarEntries(tarFile);
        if (inner.length === 0) {
          log(`⚠️ ${slot}: no se encontraron archivos dentro del .tar`, 'warn');
          continue;
        }
        const entries: TarEntry[] = [];
        for (const entry of inner) {
          if (/\.pit$/i.test(entry.name)) {
            if (!pitFile) {
              pitFile = new Uint8Array(await entry.blob.arrayBuffer());
              log(`   PIT del firmware: ${entry.name}`, 'info');
            }
            continue;
          }
          if (/^meta-data\//i.test(entry.name)) continue;
          if (skipUserdata && stripCompressionSuffix(entry.name) === 'userdata.img') continue;
          totalBytes += await writeSizeOf(entry.blob);
          entries.push(entry);
        }
        lots.push({ slot, entries });
      }

      setProgressLabel('Conectando...');
      device = await connectDevice();
      if (!device) return;

      await device.setFlashTotalSize(totalBytes);
      log(`📐 Total a escribir: ${(totalBytes / 1048576).toFixed(1)} MB`, 'info');

      if (pitFile && writePit) await device.flashPit(pitFile);
      else if (pitFile) log('⏭️ PIT del firmware NO escrito (opción "Escribir PIT" desactivada)', 'warn');

      const pitData: PitData = await device.getPitData();

      // Una sola sesión, un solo "total bytes" al principio, y después cada
      // archivo dentro de esa misma sesión. Abrir/cerrar sesión por cada
      // archivo (lo que se probó antes) interrumpe a mitad de camino la
      // verificación del binario y el bootloader lo rechaza como "Custom
      // Binary Blocked", aunque el archivo esté íntegro.
      const toFlash: { slot: OdinSlot; name: string; blob: Blob; match: NonNullable<ReturnType<typeof pitData.findEntryByFlashFilename>> }[] = [];
      for (const { slot, entries } of lots) {
        for (const entry of entries) {
          const match = pitData.findEntryByFlashFilename(entry.name);
          if (!match) {
            log(`⚠️ ${entry.name}: no está en el PIT del equipo, se omite`, 'warn');
            continue;
          }
          // userdata no es necesaria para arrancar — el equipo la formatea en
          // el primer arranque. En este modelo el equipo rechaza su integridad
          // (Auth), así que por defecto se omite para no abortar todo el lote.
          if (skipUserdata && /^userdata$/i.test(match.partitionName || '')) {
            log(`⏭️ ${entry.name}: userdata OMITIDA (no es necesaria para arrancar; el equipo la formatea sola).`, 'warn');
            continue;
          }
          toFlash.push({ slot, name: entry.name, blob: entry.blob, match });
        }
      }

      if (toFlash.length === 0) {
        log('No hay archivos para flashear después de emparejar con el PIT.', 'warn');
        setProgressLabel('Nada que flashear');
        return;
      }

      log(`📦 ${toFlash.length} archivo(s) para escribir`, 'info');

      for (const item of toFlash) {
        setProgress(0);
        setProgressLabel(`${item.slot}: ${item.name}`);
        log(`🖊 Escribiendo ${item.slot}: ${item.name} ...`, 'title');
        await device.flashFile(item.blob, item.match.binaryType, item.match.deviceType, item.match.identifier, item.match.fileSize);
      }

      if (reboot) await device.reboot();
      else await device.endSession();
      ok = true;

      const label = Object.entries(activeFiles).map(([slot, f]) => `${slot}:${f.name}`).join(' · ');
      const next = await pushHistory({
        id: crypto.randomUUID(), ts: Date.now(), label,
        files: Object.fromEntries(Object.entries(activeFiles).map(([s, f]) => [s, f.name])),
      });
      setHistory(next);
      setProgressLabel('¡Listo!');
      setProgress(1);
      log('✅✅ FLASHEO COMPLETADO ✅✅', 'ok');
      if (reboot) log('▶️ Reiniciando el equipo...', 'info');
    } catch (e) {
      log(`❌ Error: ${e instanceof Error ? e.message : String(e)}`, 'error');
      setProgressLabel('Error');
    } finally {
      if (!ok) await device?.endSession().catch(() => {});
      await device?.close().catch(() => {});
      setBusy(false);
    }
  }, [slots, reboot, checkMd5, skipUserdata, writePit, connectDevice, log]);

  const loaded = ODIN_SLOTS.filter((s) => slots[s].enabled && slots[s].file).length;

  return (
    <>
      {eraseToast && (
        <div className="fixed inset-x-0 top-20 z-50 flex justify-center px-4">
          <div className="animate-bounce rounded-2xl border border-emerald-400/50 bg-emerald-500 px-6 py-3 text-base font-black text-black shadow-[0_0_30px_rgba(52,211,153,0.6)]">
            ✅ ¡Borrado listo!
          </div>
        </div>
      )}

      {!supported && (
        <p className="mb-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-300">
          Tu navegador no soporta la API de archivos locales (File System Access) ni Web Serial.
          Usa Chrome o Edge de escritorio.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── Columna principal: firmware + opciones + flash ── */}
        <div className="space-y-5">
          <section className={CARD}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-black text-white">📦 Firmware</h2>
              <span className="rounded-full bg-orange-500/15 px-3 py-1 text-xs font-bold text-orange-300">
                {loaded} archivo(s) listo(s)
              </span>
            </div>

            <div className="mb-4 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
              <button type="button" onClick={chooseFolder} disabled={busy} className={BTN_GHOST}>
                📁 <span className="max-w-[220px] truncate">{folderName ?? 'Elegir carpeta del firmware'}</span>
              </button>
              <select
                value={selectedHistory}
                onChange={(e) => applyHistoryEntry(e.target.value)}
                className="h-12 w-full rounded-xl border border-zinc-800 bg-zinc-900/80 px-4 text-sm text-zinc-200 outline-none focus:border-orange-500/60"
              >
                <option value="">{history.length ? `🕘 ${history.length} versión(es) en el historial` : '🕘 Sin historial todavía'}</option>
                {history.map((h) => (
                  <option key={h.id} value={h.id}>{new Date(h.ts).toLocaleString('es')} — {h.label.slice(0, 60)}</option>
                ))}
              </select>
            </div>

            <div className="space-y-2.5">
              {ODIN_SLOTS.map((slot) => {
                const s = slots[slot];
                return (
                  <div key={slot}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-3 transition-colors ${s.enabled && s.file ? 'border-orange-500/30 bg-orange-500/[0.04]' : 'border-zinc-800 bg-zinc-900/40'}`}>
                    <Switch checked={s.enabled} onChange={() => toggleSlot(slot)} disabled={busy} />
                    <span className={`w-16 shrink-0 rounded-lg py-1.5 text-center text-sm font-black ${SLOT_COLOR[slot]}`}>{SLOT_LABEL[slot]}</span>
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-sm ${s.file ? 'text-zinc-100' : 'text-zinc-600'}`}>{s.file?.name ?? 'Sin archivo'}</p>
                      {s.file && <p className="text-xs text-zinc-500">{(s.file.size / 1048576).toFixed(1)} MB</p>}
                    </div>
                    <button type="button" onClick={() => openSlotFile(slot)} disabled={busy}
                      className="h-10 shrink-0 rounded-lg border border-zinc-700 px-4 text-sm font-bold text-zinc-300 transition hover:border-orange-400/60 hover:text-white disabled:opacity-40">
                      Abrir
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className={CARD}>
            <h2 className="mb-4 text-lg font-black text-white">⚙️ Opciones</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Option checked={reboot} onChange={() => setReboot((v) => !v)} disabled={busy}
                title="Reiniciar al terminar" hint="Arranca el sistema al final del flasheo" />
              <Option checked={checkMd5} onChange={() => setCheckMd5((v) => !v)} disabled={busy}
                title="Verificar MD5" hint="Comprueba los .tar.md5 antes de escribir" />
              <Option checked={writePit} onChange={() => setWritePit((v) => !v)} disabled={busy}
                title="Escribir PIT del CSC" hint="Como odin4: reparticiona con el .pit del firmware" />
              <Option checked={skipUserdata} onChange={() => setSkipUserdata((v) => !v)} disabled={busy}
                title="Omitir userdata" hint="No escribe userdata.img (se formatea sola)" />
            </div>

            <div className="mt-5 flex gap-3">
              <button type="button" onClick={flash} disabled={busy}
                className="h-14 flex-1 rounded-xl bg-gradient-to-r from-orange-500 to-amber-400 text-lg font-black tracking-wide text-black shadow-[0_8px_30px_rgba(249,115,22,0.35)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none">
                ⚡ FLASH
              </button>
              <button type="button" onClick={resetAll} disabled={busy} className={`${BTN_GHOST} h-14 px-6`}>
                Limpiar
              </button>
            </div>

            {progressLabel && (
              <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-semibold text-zinc-200">{busy ? '⏳' : progress >= 1 ? '✅' : '•'} {progressLabel}</span>
                  <span className="font-mono text-base font-bold text-orange-300">{Math.round(progress * 100)}%</span>
                </div>
                <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-black/60">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-400 transition-[width] duration-200"
                    style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }}
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {/* ── Columna lateral: acciones sobre el equipo ── */}
        <aside className="space-y-5">
          <section className={CARD}>
            <h2 className="mb-1 text-lg font-black text-white">📱 Equipo</h2>
            <p className="mb-4 text-xs text-zinc-500">El teléfono debe estar en modo Download.</p>

            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Información</p>
            <div className="grid gap-2.5">
              <ActionButton onClick={testConnection} disabled={busy} icon="🔌" title="Probar conexión" hint="Handshake ODIN/LOKE" tone="sky" />
              <ActionButton onClick={readPitOnly} disabled={busy} icon="📊" title="Leer PIT" hint="Tabla de particiones, solo lectura" tone="sky" />
              <ActionButton onClick={savePit} disabled={busy} icon="💾" title="Guardar PIT" hint="Descarga el .pit del equipo" tone="sky" />
            </div>

            <p className="mb-2 mt-5 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Acciones</p>
            <div className="grid gap-2.5">
              <ActionButton onClick={rebootDevice} disabled={busy} icon="🔄" title="Reiniciar equipo" hint="Sale del modo Download" tone="emerald" />
              <ActionButton onClick={eraseUserdata} disabled={busy} icon="🗑️" title="Erase Userdata" hint="Factory reset — borra los datos" tone="red" />
            </div>
          </section>
        </aside>
      </div>

      {pit && (
        <section className={`${CARD} mt-5`}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-black text-white">📊 PIT del equipo <span className="text-sm font-semibold text-zinc-500">({pit.length} particiones)</span></h2>
            <button type="button" onClick={() => setPit(null)} className="text-sm font-bold text-zinc-500 hover:text-white">✕ Cerrar</button>
          </div>
          <div className="max-h-[320px] overflow-y-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-900 text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-4 py-2.5 text-left">Partición</th>
                  <th className="px-4 py-2.5 text-left">Archivo</th>
                  <th className="px-4 py-2.5 text-left">ID</th>
                  <th className="px-4 py-2.5 text-left">Tipo</th>
                </tr>
              </thead>
              <tbody>
                {pit.map((p, i) => (
                  <tr key={i} className="border-t border-zinc-800/80 text-zinc-300 hover:bg-white/[0.03]">
                    <td className="px-4 py-2 font-semibold text-zinc-100">{p.partitionName}</td>
                    <td className="px-4 py-2 font-mono text-xs">{p.flashFilename || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs">{p.identifier}</td>
                    <td className="px-4 py-2 text-xs">{p.binaryType === 1 ? 'CP (modem)' : 'AP'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Consola ── */}
      <section className="mt-5 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-red-500/80" />
            <span className="h-3 w-3 rounded-full bg-amber-400/80" />
            <span className="h-3 w-3 rounded-full bg-emerald-500/80" />
            <span className="ml-2 text-sm font-bold text-zinc-400">Consola</span>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={copyLog} className="rounded-lg px-3 py-1 text-xs font-bold text-zinc-400 hover:bg-white/5 hover:text-white">📋 Copiar</button>
            <button type="button" onClick={clear} disabled={busy} className="rounded-lg px-3 py-1 text-xs font-bold text-zinc-400 hover:bg-white/5 hover:text-white disabled:opacity-40">🧹 Limpiar</button>
          </div>
        </div>
        <div ref={consoleRef} className="h-[380px] overflow-y-auto px-4 py-3 font-mono text-sm leading-relaxed">
          {logs.map((l, i) => (
            <p key={i} className={`break-all ${LOG_COLOR[l.kind]}`}>
              <span className="mr-2 text-zinc-600">{l.t}</span>{l.text}
            </p>
          ))}
        </div>
      </section>
    </>
  );
}

const CARD = 'rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900/80 to-zinc-950 p-5 shadow-xl shadow-black/40';
const BTN_GHOST = 'flex h-12 items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900/60 px-4 text-sm font-bold text-zinc-200 transition hover:border-orange-400/60 hover:text-white disabled:opacity-40';

const SLOT_COLOR: Record<OdinSlot, string> = {
  BL: 'bg-sky-500/15 text-sky-300',
  AP: 'bg-orange-500/15 text-orange-300',
  CP: 'bg-violet-500/15 text-violet-300',
  CSC: 'bg-emerald-500/15 text-emerald-300',
  DATA: 'bg-pink-500/15 text-pink-300',
};

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={onChange} disabled={disabled}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? 'bg-orange-500' : 'bg-zinc-700'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

function Option({ checked, onChange, disabled, title, hint }: {
  checked: boolean; onChange: () => void; disabled?: boolean; title: string; hint: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
      <div className="min-w-0">
        <p className="text-sm font-bold text-zinc-100">{title}</p>
        <p className="text-xs text-zinc-500">{hint}</p>
      </div>
    </div>
  );
}

const TONE = {
  sky: 'border-sky-500/25 hover:border-sky-400/60 hover:bg-sky-500/10',
  emerald: 'border-emerald-500/25 hover:border-emerald-400/60 hover:bg-emerald-500/10',
  red: 'border-red-500/30 hover:border-red-400/70 hover:bg-red-500/10',
} as const;

function ActionButton({ onClick, disabled, icon, title, hint, tone }: {
  onClick: () => void; disabled?: boolean; icon: string; title: string; hint: string; tone: keyof typeof TONE;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`flex items-center gap-3 rounded-xl border bg-zinc-900/50 px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${TONE[tone]}`}>
      <span className="text-2xl">{icon}</span>
      <span className="min-w-0">
        <span className={`block text-sm font-bold ${tone === 'red' ? 'text-red-300' : 'text-zinc-100'}`}>{title}</span>
        <span className="block text-xs text-zinc-500">{hint}</span>
      </span>
    </button>
  );
}
