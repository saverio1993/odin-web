# Odin Web ⚡

**Flasher de firmware para dispositivos Samsung (modo *Download*) directamente desde el navegador.**
Implementa el protocolo **Odin** sobre **WebUSB** y **Web Serial**, por lo que funciona sin instalar Odin ni Heimdall — solo Chrome o Edge de escritorio.

> ⚠️ **Aviso:** flashear o borrar un dispositivo real es una operación destructiva y puede **brickear** el equipo o **borrar tus datos**. Úsalo bajo tu propia responsabilidad.

---

## ✨ Características

- 🔌 **Conexión por Serial (COM)** — usa el *Gadget Serial* de Samsung con el driver normal, **sin necesidad de Zadig/WinUSB**.
- 🔌 **Conexión por WebUSB** — alternativa (requiere driver WinUSB).
- 📦 **Carga de firmware estilo Odin** — slots **BL / AP / CP / CSC / USERDATA**.
- 🗜️ **Descompresión LZ4** automática de las imágenes `.img.lz4`.
- 📄 **Lectura de la PIT** y emparejamiento automático imagen → partición.
- 🔎 **Analizar (dry-run)** — muestra qué imagen irá a cada partición **sin escribir nada**.
- ⚡ **FLASH** multipartición en una sola sesión.
- 🗑️ **Erase Userdata**, **Reboot**, **Download PIT** y más funciones manuales.
- 🖥️ **Consola** integrada con logs legibles de cada operación.

---

## 🚀 Uso

### Requisitos
- **Chrome** o **Edge** de escritorio (WebUSB / Web Serial no existen en Firefox/Safari).
- Un Samsung en **Download Mode** (apagar → mantener `Vol-` + `Vol+` y conectar el cable, o el combo de tu modelo).

### Arrancar la app
```sh
cd example
npm install
npm run dev
```
Abre **http://localhost:5173** en Chrome/Edge.

### Flujo de flasheo
1. **Conectar por Serial (COM)** → elige `SAMSUNG USB - Gadget Serial Control (COMx)`. Debe salir `✅ Handshake OK`.
2. En **Cargar firmware**, selecciona tus archivos en los slots (`.tar` / `.tar.md5`):
   - **BL** · Bootloader
   - **AP** · System/PDA
   - **CP** · Modem
   - **CSC** · Región (borra datos) / **HOME_CSC** (conserva datos)
   - **USERDATA** · opcional ⚠️ (borra datos)
3. Pulsa **🔎 Analizar (dry-run)** y revisa que cada imagen mapee a su partición correcta.
4. Pulsa **⚡ FLASH** y confirma. Marca **Reboot al terminar** si quieres que arranque solo.

> 💡 Empieza probando una partición pequeña (p. ej. `boot` o `recovery`) antes de un AP completo. El `super.img` descomprimido puede ser de varios GB y llegar al límite de memoria del navegador.

---

## 🧩 Cómo funciona

```
.tar / .tar.md5  ─▶  parseo TAR  ─▶  .img.lz4  ─▶  descompresión LZ4  ─▶  .img
                                                                           │
   PIT del dispositivo ──▶ empareja por flashFilename ──▶ partición ◀──────┘
                                                                           │
                                          sesión Odin: setFlashTotalSize + sendFile
```

- **Transporte Serial:** un adaptador imita la interfaz USB (`transferOut`/`transferIn`) pero lee/escribe por el puerto COM. Handshake de 4 bytes (`ODIN` → `LOKE`), señal **DTR** activada, sin *empty transfers*.
- **Núcleo del protocolo:** basado en [libmjolnir](https://github.com/r3pwn/libmjolnir) (PIT, handshake, sesión, flash, erase).

---

## 📁 Estructura

| Ruta | Descripción |
|---|---|
| `src/` | Librería del protocolo Odin (libmjolnir) |
| `example/src/App.vue` | Interfaz del flasher (Vue 3) |
| `example/src/odin-flash.ts` | TAR + LZ4 + flasheo por PIT |
| `example/src/serial-odin.ts` | Transporte Web Serial (puerto COM) |

---

## ⚠️ Descargo de responsabilidad

Esta herramienta se ofrece **tal cual**, sin garantía de ningún tipo. El flasheo de firmware puede dañar permanentemente tu dispositivo, anular la garantía o provocar pérdida de datos. **El autor no se hace responsable** de ningún daño. Haz copias de seguridad y asegúrate de usar el firmware correcto para tu modelo exacto.

---

## 📜 Licencia y créditos

- Licencia **MIT** (ver [`LICENSE`](LICENSE)).
- Núcleo del protocolo Odin basado en **[libmjolnir](https://github.com/r3pwn/libmjolnir)** de Greg Willard (r3pwn).

---

<div align="center">

### ✍️ Desarrollado por **saverio1993**

🔗 [github.com/saverio1993](https://github.com/saverio1993)

</div>
