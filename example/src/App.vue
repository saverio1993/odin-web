<script setup lang="ts">
  import { ref, onMounted, computed } from 'vue';
  import { OdinDevice, libpit } from 'libmjolnir';
  import { version as libmjolnirVersion } from 'libmjolnir/package.json';
  import { analyzeFirmware, flashFirmware, type PlanItem } from './odin-flash';
  import { requestSerialDevice } from './serial-odin';

  import PartitionEntry from './components/PartitionEntry.vue';

  const hasDevice = ref(false);
  const connecting = ref(false);
  const busy = ref(false);
  const sessionActive = ref(false);
  const devicePit = ref(undefined as libpit.PitData | undefined);
  const connectedDevice = ref(undefined as OdinDevice | undefined);
  const showDriverHint = ref(false);
  const showAdvanced = ref(false);

  const verboseLogging = ref(true);
  const defaultTimeout = ref(15000);
  const resetOnInit = ref(false);

  // ---- Slots de firmware estilo Odin ----
  type Slot = { key: string, label: string, enabled: boolean, file: File | null };
  const slots = ref<Slot[]>([
    { key: 'BL',       label: 'BL · Bootloader',     enabled: false, file: null },
    { key: 'AP',       label: 'AP · System/PDA',     enabled: false, file: null },
    { key: 'CP',       label: 'CP · Modem',          enabled: false, file: null },
    { key: 'CSC',      label: 'CSC · Region',        enabled: false, file: null },
    { key: 'USERDATA', label: 'USERDATA · DATA ⚠',   enabled: false, file: null },
  ]);
  const rebootAfter = ref(true);
  const plan = ref<PlanItem[]>([]);

  function onSlotFile (slot: Slot, e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0] || null;
    slot.file = f;
    slot.enabled = !!f;
    plan.value = [];
  }
  const activeSlots = computed(() => slots.value.filter(s => s.enabled && s.file));

  async function readSlots () {
    const out: { slot: string, fileName: string, buf: Uint8Array }[] = [];
    for (const s of activeSlots.value) {
      const buf = new Uint8Array(await s.file!.arrayBuffer());
      out.push({ slot: s.key, fileName: s.file!.name, buf });
    }
    return out;
  }

  // ---- Consola ----
  const autoScroll = ref(true);
  const logLines = ref([] as { type: string, text: string, ts: string }[]);
  const icon: Record<string, string> = { info: 'ℹ', log: '›', warn: '⚠', error: '✖' };
  function pushLog (type: string, args: any[]) {
    const text = args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (a instanceof Uint8Array) return `Uint8Array(${a.length})`;
      if (typeof a === 'object' && a !== null) {
        if (typeof (a as any).size === 'number' && (a as any).data) {
          const p: any = a;
          const fields = ['controlType', 'request', 'responseType', 'result', 'receivedSize', 'fileSize']
            .filter(k => p[k] !== undefined).map(k => `${k}=${p[k]}`).join(', ');
          return `Packet(size=${p.size}${fields ? ', ' + fields : ''})`;
        }
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');
    const ts = new Date().toLocaleTimeString('es-ES', { hour12: false });
    logLines.value.push({ type, text, ts });
    if (/unable to open and claim|InvalidStateError|claim (interface|device)|access denied/i.test(text)) {
      showDriverHint.value = true;
    }
    if (autoScroll.value) {
      setTimeout(() => { const el = document.getElementById('log-console'); if (el) el.scrollTop = el.scrollHeight; }, 0);
    }
  }
  function clearLog () { logLines.value = []; }
  const flog = (msg: string, type = 'log') => pushLog(type, [msg]);

  onMounted(() => {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a: any[]) => { orig.log(...a); pushLog('log', a); };
    console.warn = (...a: any[]) => { orig.warn(...a); pushLog('warn', a); };
    console.error = (...a: any[]) => { orig.error(...a); pushLog('error', a); };
    pushLog('info', ['Listo. Conecta un Samsung en Download Mode y pulsa "Request device access".']);
  });

  const d = () => connectedDevice.value!;

  // Serializa comandos para no solapar dos operaciones en el tubo USB
  async function run (label: string, fn: () => any | Promise<any>, needsDevice = true) {
    if (needsDevice && !connectedDevice.value) {
      pushLog('warn', [`[${label}] No hay dispositivo conectado.`]); return;
    }
    if (busy.value) {
      pushLog('warn', [`⏳ "${label}" ignorado: hay otra operación en curso.`]); return;
    }
    busy.value = true;
    pushLog('info', [`▶ ${label}...`]);
    try {
      const result = await fn();
      if (result !== undefined) pushLog('log', [`✔ ${label} →`, result]);
      else pushLog('log', [`✔ ${label} OK`]);
    } catch (e: any) {
      pushLog('error', [`✖ ${label} falló:`, e]);
    } finally { busy.value = false; }
  }

  async function ensureSession () {
    if (sessionActive.value) return;
    pushLog('info', ['· abriendo sesión (beginSession)...']);
    await d().beginSession();
    sessionActive.value = true;
  }

  // ---- Conexión (USB o Serial) ----
  async function connectVia (kind: 'usb' | 'serial') {
    if (connecting.value) { pushLog('warn', ['Ya hay una conexión en curso, espera...']); return; }
    connecting.value = true;
    const opts = { logging: verboseLogging.value, timeout: defaultTimeout.value, resetOnInit: resetOnInit.value };
    await run(kind === 'serial' ? 'Conectar por Serial (COM)' : 'Conectar por USB', async () => {
      let device: OdinDevice;
      if (kind === 'serial') {
        device = await requestSerialDevice(opts);
        pushLog('log', ['Puerto serie Samsung seleccionado (no requiere cambiar driver) — conectando...']);
      } else {
        if (!navigator.usb) throw new Error('Este navegador no soporta WebUSB (usa Chrome o Edge).');
        const SAMSUNG = 0x04E8;
        let usbDev = (await navigator.usb.getDevices()).find(d => d.vendorId === SAMSUNG);
        if (usbDev) pushLog('info', [`Samsung USB ya emparejado detectado — conectando directo...`]);
        else usbDev = await navigator.usb.requestDevice({ filters: [{ vendorId: SAMSUNG }] });
        device = new OdinDevice(usbDev, opts);
        pushLog('log', ['USB device:', usbDev.productName || '(sin nombre)',
          `VID=0x${usbDev.vendorId?.toString(16)} PID=0x${usbDev.productId?.toString(16)}`]);
      }
      connectedDevice.value = device;
      await device.initialize();
      hasDevice.value = true;
      showDriverHint.value = false;
      device.onDisconnect(() => {
        hasDevice.value = false; sessionActive.value = false; devicePit.value = undefined; connectedDevice.value = undefined;
        pushLog('warn', ['Dispositivo desconectado.']);
      });
      return 'inicializado y handshake OK';
    }, false);
    connecting.value = false;
  }
  const requestSerialAccess = () => connectVia('serial');

  // ---- Flasher de firmware ----
  async function doAnalyze () {
    if (!activeSlots.value.length) { pushLog('warn', ['Selecciona al menos un archivo (BL/AP/CP/CSC).']); return; }
    await run('Analizar firmware (dry-run)', async () => {
      await ensureSession();
      const pit = devicePit.value ?? await d().getPitData();
      devicePit.value = pit;
      const fw = await readSlots();
      plan.value = analyzeFirmware(fw, pit);
      const matched = plan.value.filter(p => p.matched).length;
      const unmatched = plan.value.length - matched;
      return `${plan.value.length} imágenes · ${matched} con partición · ${unmatched} sin emparejar`;
    });
  }

  async function doFlashFirmware () {
    if (!activeSlots.value.length) { pushLog('warn', ['Selecciona al menos un archivo (BL/AP/CP/CSC).']); return; }
    const names = activeSlots.value.map(s => `${s.key}: ${s.file!.name}`).join('\n');
    const dataWarn = slots.value.find(s => s.key === 'USERDATA')?.enabled ? '\n\n⚠ USERDATA activo: se BORRARÁN los datos del teléfono.' : '';
    if (!confirm(`Vas a FLASHEAR firmware:\n\n${names}\n\nReboot al terminar: ${rebootAfter.value ? 'sí' : 'no'}${dataWarn}\n\nUn flasheo incorrecto puede BRICKEAR el equipo. ¿Continuar?`)) {
      pushLog('warn', ['Flasheo cancelado por el usuario.']); return;
    }
    await run('FLASH firmware', async () => {
      const fw = await readSlots();
      await flashFirmware(d(), fw, { reboot: rebootAfter.value, log: flog });
      sessionActive.value = false; // flashFirmware cierra la sesión
    });
  }

  // ---- Funciones manuales (avanzado) ----
  const doHandshake     = () => run('handshake', () => d().handshake());
  const doDeviceType    = () => run('requestDeviceType', () => d().requestDeviceType());
  const doBeginSession  = () => run('beginSession', async () => { await d().beginSession(); sessionActive.value = true; return 'sesión iniciada'; });
  const doDownloadPit   = () => run('getPitData (Download PIT)', async () => {
    await ensureSession();
    const pit = await d().getPitData(); devicePit.value = pit;
    return `boardType=${pit.boardType}, ${pit.entries.length} particiones`;
  });
  const doEndSession    = () => run('endSession', async () => { await d().endSession(); sessionActive.value = false; return 'sesión finalizada'; });
  const doReboot        = () => run('reboot', () => d().reboot());
  const doEraseUserdata = () => {
    if (!confirm('⚠ ERASE USERDATA borrará los datos del dispositivo. ¿Continuar?')) return;
    run('eraseUserdata', async () => { await ensureSession(); await d().eraseUserdata(); });
  };
  const doClose         = () => run('close', () => d().close());

  async function flashPartition (data: { name: string, data: Uint8Array }) {
    if (!confirm(`⚠ Vas a FLASHEAR la partición "${data.name}" (${data.data.length} bytes). ¿Continuar?`)) return;
    await run(`flashPartition(${data.name})`, () => d().flashPartition(data.name, data.data));
  }

  const fmtMB = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
</script>

<template>
  <h2>libmjolnir <small>v{{ libmjolnirVersion }}</small> · Flasher Odin web</h2>
  <p class="muted">Protocolo Odin (Samsung Download Mode) sobre WebUSB — solo Chrome/Edge.</p>

  <!-- 1. Conexión -->
  <fieldset class="box">
    <legend>1 · Conexión</legend>
    <div class="row">
      <button class="primary" :disabled="connecting" @click="requestSerialAccess" title="Puerto COM — no requiere Zadig/WinUSB">
        <template v-if="connecting">⏳ Conectando…</template>
        <template v-else>{{ hasDevice ? '🔌 Reconectar' : '🔌 Conectar por Serial (COM) ✅' }}</template>
      </button>
      <span class="status" :class="{ on: hasDevice, busy: connecting || busy }">
        {{ connecting ? 'Conectando…' : hasDevice ? 'Conectado' : 'Sin dispositivo' }}
        <template v-if="sessionActive"> · sesión activa</template>
        <template v-if="busy"> · ⏳ ocupado</template>
      </span>
      <label class="opt"><input type="checkbox" v-model="verboseLogging" /> verbose</label>
      <label class="opt">timeout <input class="num" type="number" v-model="defaultTimeout" /></label>
      <label class="opt"><input type="checkbox" v-model="resetOnInit" /> reset on init</label>
    </div>
  </fieldset>

  <div class="hintbox" v-if="showDriverHint">
    <b>⚠ Windows no deja al navegador reclamar el dispositivo (driver incorrecto).</b>
    Cierra Odin / Smart Switch, abre <a href="https://zadig.akeo.ie" target="_blank" rel="noopener">Zadig</a> con el teléfono en Download Mode →
    <i>Options ▸ List All Devices</i> → elige el Samsung → driver <b>WinUSB</b> → <b>Replace Driver</b>. Recarga y reconecta.
    <button class="mini" @click="showDriverHint = false">ocultar</button>
  </div>

  <!-- 2. Firmware -->
  <fieldset class="box" :disabled="busy">
    <legend>2 · Cargar firmware (.tar / .tar.md5 / .img.lz4)</legend>
    <table class="slots">
      <tbody>
        <tr v-for="s in slots" :key="s.key" :class="{ danger: s.key === 'USERDATA' }">
          <td><input type="checkbox" v-model="s.enabled" :disabled="!s.file" /></td>
          <td class="slotname">{{ s.label }}</td>
          <td class="filecell">
            <input type="file" accept=".tar,.md5,.lz4,.img,.bin" @change="onSlotFile(s, $event)" />
          </td>
          <td class="sizecell">{{ s.file ? fmtMB(s.file.size) : '—' }}</td>
        </tr>
      </tbody>
    </table>
    <div class="row" style="margin-top:.6rem">
      <label class="opt"><input type="checkbox" v-model="rebootAfter" /> Reboot al terminar</label>
      <button :disabled="!hasDevice || !activeSlots.length" @click="doAnalyze">🔎 Analizar (dry-run)</button>
      <button class="flash" :disabled="!hasDevice || !activeSlots.length" @click="doFlashFirmware">⚡ FLASH</button>
      <button class="danger" :disabled="!hasDevice || busy" @click="doEraseUserdata">🗑️ Erase Userdata</button>
    </div>
    <p class="hint">Analizar descarga la PIT y muestra qué imagen va a cada partición, <b>sin escribir nada</b>. Revísalo antes de pulsar FLASH.</p>
  </fieldset>

  <!-- Plan / dry-run -->
  <fieldset class="box" v-if="plan.length">
    <legend>Plan de flasheo ({{ plan.filter(p => p.matched).length }}/{{ plan.length }} emparejadas)</legend>
    <table class="plan">
      <thead><tr><th>Slot</th><th>Archivo</th><th></th><th>Partición</th><th>ID</th><th>Tamaño</th><th>LZ4</th></tr></thead>
      <tbody>
        <tr v-for="(p, i) in plan" :key="i" :class="{ nomatch: !p.matched }">
          <td>{{ p.slot }}</td>
          <td class="mono">{{ p.fileName }}</td>
          <td>{{ p.matched ? '→' : '✖' }}</td>
          <td class="mono">{{ p.partitionName || '(sin partición en PIT)' }}</td>
          <td>{{ p.identifier ?? '' }}</td>
          <td>{{ fmtMB(p.size) }}{{ p.compressed ? ' (comp.)' : '' }}</td>
          <td>{{ p.compressed ? '✔' : '' }}</td>
        </tr>
      </tbody>
    </table>
  </fieldset>

  <!-- 3. Avanzado -->
  <fieldset class="box">
    <legend>
      <button class="mini" @click="showAdvanced = !showAdvanced">{{ showAdvanced ? '▼' : '▶' }} Avanzado (manual)</button>
    </legend>
    <div v-show="showAdvanced">
      <div class="grid" :class="{ off: !hasDevice || busy }">
        <button :disabled="!hasDevice || busy" @click="doHandshake">🤝 Handshake</button>
        <button :disabled="!hasDevice || busy" @click="doDeviceType">ℹ️ Device Type</button>
        <button :disabled="!hasDevice || busy" @click="doBeginSession">▶️ Begin Session</button>
        <button :disabled="!hasDevice || busy" @click="doDownloadPit">⬇️ Download PIT</button>
        <button :disabled="!hasDevice || busy" @click="doEndSession">⏹️ End Session</button>
        <button :disabled="!hasDevice || busy" @click="doReboot">🔄 Reboot</button>
        <button class="danger" :disabled="!hasDevice || busy" @click="doEraseUserdata">🗑️ Erase Userdata</button>
        <button :disabled="!hasDevice || busy" @click="doClose">❌ Close</button>
      </div>

      <template v-if="devicePit?.entries?.length">
        <h4>Particiones de la PIT · boardType: {{ devicePit.boardType }}</h4>
        <template v-for="(entry, index) in devicePit.entries" :key="entry.identifier">
          <partition-entry :entry="entry" @flash="flashPartition" />
          <hr v-if="index !== devicePit.entries.length - 1" />
        </template>
      </template>
    </div>
  </fieldset>

  <!-- Consola -->
  <fieldset class="box">
    <legend>
      Consola <span class="badge">{{ logLines.length }}</span>
      <button class="mini" @click="clearLog">limpiar</button>
      <label class="mini-check"><input type="checkbox" v-model="autoScroll" /> autoscroll</label>
    </legend>
    <div id="log-console" class="console">
      <div v-if="!logLines.length" class="empty">— sin registros —</div>
      <div v-for="(l, i) in logLines" :key="i" :class="['line', l.type]">
        <span class="ts">{{ l.ts }}</span>
        <span class="ic">{{ icon[l.type] || '·' }}</span>
        <span class="txt">{{ l.text }}</span>
      </div>
    </div>
  </fieldset>
</template>

<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 1rem auto; padding: 0 1rem; }
  h2 { margin-bottom: 0; }
  h2 small { font-weight: normal; opacity: .6; font-size: .55em; }
  h4 { margin: 1rem 0 .5rem; }
  .muted { opacity: .7; margin-top: .25rem; }
  .box { border: 1px solid #8884; border-radius: 8px; margin: 1rem 0; padding: .75rem 1rem; }
  .box[disabled] { opacity: .5; }
  .box legend { padding: 0 .4rem; font-weight: 600; }
  .row { display: flex; align-items: center; gap: .9rem; flex-wrap: wrap; }
  .opt { display: inline-flex; align-items: center; gap: .3rem; font-size: .85rem; opacity: .85; }
  .num { width: 80px; }
  .status { padding: .2rem .6rem; border-radius: 999px; background: #8883; font-size: .85rem; }
  .status.on { background: #2e7d3255; }
  .status.busy { background: #ff980055; }
  .hintbox { border: 1px solid #ff9800; background: #ff980018; border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; font-size: .88rem; line-height: 1.5; }
  .hintbox a { color: #ff9800; font-weight: 600; }
  table.slots { width: 100%; border-collapse: collapse; }
  table.slots td { padding: .35rem .4rem; border-bottom: 1px solid #8882; vertical-align: middle; }
  table.slots .slotname { font-weight: 600; white-space: nowrap; }
  table.slots .filecell { width: 100%; }
  table.slots .filecell input { width: 100%; }
  table.slots .sizecell { text-align: right; opacity: .7; white-space: nowrap; font-size: .85rem; }
  table.slots tr.danger .slotname { color: #e57373; }
  table.plan { width: 100%; border-collapse: collapse; font-size: .82rem; }
  table.plan th, table.plan td { padding: .25rem .5rem; border-bottom: 1px solid #8882; text-align: left; }
  table.plan tr.nomatch { opacity: .55; }
  table.plan tr.nomatch td { color: #e0a; }
  .mono { font-family: ui-monospace, monospace; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .5rem; }
  .grid.off { opacity: .55; }
  button { padding: .5rem .7rem; border-radius: 6px; border: 1px solid #8886; background: #8882; cursor: pointer; font-size: .9rem; }
  button:hover:not(:disabled) { background: #8884; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  button.primary { background: #1976d2; color: #fff; border-color: #1976d2; }
  button.flash { background: #f57c00; color: #fff; border-color: #f57c00; font-weight: 700; }
  button.danger, button.danger:hover { background: #c62828; color: #fff; border-color: #c62828; }
  button.mini { padding: 0 .4rem; font-size: .75rem; margin-left: .3rem; background: transparent; border: none; }
  .mini-check { display: inline-flex; font-size: .7rem; opacity: .75; margin-left: .5rem; gap: .2rem; }
  .badge { background: #8884; border-radius: 999px; padding: 0 .4rem; font-size: .7rem; font-weight: normal; }
  .hint { font-size: .8rem; opacity: .7; margin-bottom: 0; }
  .console { background: #0c0c0c; color: #ddd; font-family: ui-monospace, monospace; font-size: .78rem; height: 240px; overflow-y: auto; padding: .4rem; border-radius: 6px; }
  .console .empty { opacity: .4; padding: .3rem; }
  .line { display: flex; gap: .5rem; padding: 1px .2rem; border-bottom: 1px solid #ffffff08; white-space: pre-wrap; }
  .line .ts { color: #666; flex: 0 0 auto; }
  .line .ic { flex: 0 0 1em; text-align: center; }
  .line .txt { flex: 1 1 auto; word-break: break-word; }
  .line.info { color: #7fb0ff; }
  .line.log  { color: #cfcfcf; }
  .line.warn { color: #ffcf6b; }
  .line.error { color: #ff7b7b; }
</style>
