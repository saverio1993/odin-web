# Odin Web ⚡

Flasher de firmware Samsung (modo *Download*) desde el navegador, por **Web Serial**. No hace falta instalar Odin, Heimdall ni Zadig: usa el puerto COM normal del driver de Samsung con Chrome o Edge de escritorio.

> ⚠️ Flashear es una operación destructiva: un firmware equivocado puede dejar el equipo inutilizable y el CSC normal borra los datos. Úsalo bajo tu propia responsabilidad.

## Qué lo hace distinto

El protocolo está **calcado de odin4** (v1.2.13, el que usa SamFwTool). Para replicarlo se capturó el USB con USBPcap durante un flasheo real que salió bien, y el código se ajustó hasta que una simulación con el firmware completo produjo **los mismos 1141 paquetes de control** que odin4. Los detalles están en [`docs/PROTOCOLO_odin4.md`](docs/PROTOCOLO_odin4.md).

El flujo es el siguiente:

1. `ODIN` → `LOKE`
2. Inicio de sesión (`64/0`, versión 5), paquetes de 1 MiB (`64/5`) y tamaño total descomprimido (`64/2`).
3. Escribe el PIT del CSC (`65/0`, `65/2`, datos, `65/3`) y después lee el PIT del equipo (`65/1`).
4. Cada imagen se envía en tramos de 30 MiB: `66/0` → `66/2` → paquetes de 1 MiB → `66/3`. Los `.lz4` se descomprimen en el navegador, dentro de un Web Worker.
5. Cierre con `67/0` y reinicio con `67/1`.

Probado en un **SM-A065M** con el firmware `A065MUBSECZG1` (bit 14).

## Estructura

| Ruta | Contenido |
|---|---|
| `lib/odin/` | Protocolo: `device.ts` (orquestación), `packets.ts`, `pit.ts`, `transport.ts` (Web Serial), `lz4.ts`, `md5.ts` |
| `lib/odin-firmware-set.ts` | Detecta el set BL/AP/CP/CSC en una carpeta y lee los `.tar` |
| `components/odin-flash-tool.tsx` | Componente React/Next.js de la herramienta |
| `public/odin-lz4-worker.js` | Worker que descomprime los LZ4 (va como archivo estático) |
| `docs/PROTOCOLO_odin4.md` | El protocolo capturado de odin4, paquete por paquete |
| `tools/` | Scripts para capturar el USB de odin4 con USBPcap (Windows) |

Está pensado para usarse dentro de una app Next.js con el alias `@/` apuntando a la raíz, igual que en academia-jrubio.com/herramientas.

## Requisitos

- Chrome o Edge de escritorio (Web Serial no existe en Firefox ni Safari).
- Driver USB de Samsung instalado.
- El teléfono en modo Download, **sin MDM**, y con un firmware de bit **igual o mayor** al que tiene el equipo.

## Licencia

MIT. Es un port de [libmjolnir](https://github.com/lineageos-infra/libmjolnir) (Copyright © 2023 Greg Willard), con el flujo ajustado a odin4.
