# Protocolo USB de odin4 (d.exe v1.2.13), capturado el 13/10/2026

Flasheo de referencia: SM-A065M, firmware A065MUBSECZG1 (bit 14), con BL+AP+CP+CSC. EXIT 0 en 398 s.
Captura: `C:\OdinPy\captura\20261013_165558\usb_hub1.pcap` (el Samsung es el dispositivo 9, 04E8:685D).

Todos los enteros son **u32 little-endian**.
- **Comando (PC → teléfono):** 1024 bytes, con relleno de ceros: `[cmd, sub, arg0, arg1, ...]`.
- **Respuesta (teléfono → PC):** 8 bytes: `[cmd, valor]`. Si el teléfono responde `ffffffff`, es un error.

## 1. Saludo
| PC → teléfono | Teléfono → PC |
|---|---|
| `"ODIN"`, 4 bytes en ASCII | `"LOKE"` |

## 2. Sesión (0x64)
| PC → teléfono | Teléfono → PC | Significado |
|---|---|---|
| `64 0 5` | `64 0x20000` | Inicio de sesión. 5 = versión del protocolo; el teléfono responde con su versión |
| `64 5 0x100000` | `64 0` | Tamaño de paquete de datos: 1 MB |
| `64 2 <lo> <hi>` | `64 0` | Tamaño total en u64 = suma de los tamaños **descomprimidos** de todo lo que se va a enviar |

## 3. PIT (0x65)
odin4 **siempre** escribe el PIT que viene dentro del CSC y después lo vuelve a leer.

| PC → teléfono | Teléfono → PC |
|---|---|
| `65 0` | `65 0` (empieza a escribir el PIT) |
| `65 2 <tamaño del PIT>` | `65 0` |
| *(el PIT crudo en un solo bulk)* | `65 0` |
| `65 3 <tamaño del PIT>` | `65 0` (si el móvil tiene MDM/bloqueo, aquí responde `ffffffff`) |
| `65 1` | `65 0x4000` (empieza a leer el PIT; el teléfono indica 16 KB) |
| `65 2 <i>` con i = 0 … 0x20 | 500 bytes por cada i (el último trae 384) |
| `65 3` | `65 0` |

## 4. Archivos (0x66), un ciclo por cada imagen del TAR
Los `.lz4` **se descomprimen en el PC** y se envían en crudo. En los datos aparecen `AVB0`, `ANDROID!`, etc.

```
66 0                      -> 66 0        (empieza la transferencia)
66 2 <tamSecuencia>       -> 66 0        tamSecuencia = bytes de este tramo redondeados hacia arriba a múltiplos de 0x20000
   N paquetes de 1 MB     -> por cada uno, IN de 8 bytes: [0, índice] (0,1,2,...)
   (el último paquete se rellena con ceros hasta 1 MB)
66 3 0 <bytesReales> 0 2 <idPartición> <finDeArchivo>  -> 66 0
```
- Los archivos grandes van en tramos de **30 MB** (`0x1E00000`), con `finDeArchivo = 0`. El último tramo lleva `finDeArchivo = 1`.
- `idPartición` es el identificador de la partición en el PIT (por ejemplo preloader = 0x50).
- El `2` es el tipo de dispositivo/almacenamiento que manda odin4. Es fijo.
- Entre archivos hay unos 200 ms de pausa.
- En total: 366 secuencias, 10.85 GB enviados.

## 5. Cierre (0x67)
| PC → teléfono | Teléfono → PC | Significado |
|---|---|---|
| `67 0` | `67 0` (tarda unos 2.3 s) | Fin de la sesión |
| `67 1` | `67 0` | Reiniciar el teléfono |
