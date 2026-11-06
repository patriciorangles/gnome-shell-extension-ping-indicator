# Ping Indicator

Extensión de GNOME Shell que vigila tu conexión desde la barra superior: latencia, pérdida y jitter hacia el **router** y hacia **internet**, con diagnóstico automático cuando algo se degrada y control del Wi-Fi cuando hay varios puntos de acceso.

- GNOME Shell 48 (probado en 48.7), Wayland.
- Idioma de la interfaz: español.

## Qué hace

### 1. Medición continua
- Dos íconos en el panel: **router** (primer salto, gateway) e **internet** (por defecto `8.8.8.8`, configurable), cada uno con su latencia en ms al lado (opcional).
- Cada ciclo envía una ráfaga de pings (`ping -n`, sin DNS para evitar falsos cortes) y calcula latencia, **pérdida** y **jitter**.
- Color según umbrales configurables: bueno / medio / malo.
- Variante "inestable" del ícono cuando hay pérdida o jitter altos aunque la latencia sea buena.
- El gateway se vuelve a leer en cada ciclo, así que cambiar de Wi-Fi a hotspot del celular (o al revés) se refleja solo.
- Cadencia adaptativa: más espaciada cuando todo va bien y más rápida mientras hay problemas.

### 2. Diagnóstico automático (mtr)
- Al detectar inestabilidad lanza `mtr` y señala **en qué salto** está el problema.
- Interpreta el resultado con criterio: la pérdida en un salto intermedio solo cuenta si persiste en los saltos siguientes (muchos routers limitan ICMP y no es un fallo real).
- Con enfriamiento configurable para no repetirlo continuamente.

### 3. Historial de novedades
- Menú "Novedades" con los cambios de estado: pasó a medio/malo/inestable, **corte total** y recuperación.
- Un cambio solo se registra tras **N mediciones consecutivas** (configurable), para no llenar el historial cuando un valor oscila sobre el umbral. El corte total tiene sus propios valores de entrada y salida.

### 4. Wi-Fi: saltos entre puntos de acceso
Pensado para redes con varios equipos con el mismo nombre (mesh, repetidores, bandas 2.4 y 5 GHz).

- Detecta cuando el equipo **salta repetidamente** entre puntos de acceso de la misma red y muestra un ícono de rebote en el panel.
- El submenú Wi-Fi agrupa los BSSID por equipo físico ("Equipo 1", "Equipo 2"…), con banda, canal y señal de cada uno.
- **Fijar un punto de acceso**: escribe el BSSID en el perfil de NetworkManager (equivale a `nmcli connection modify <perfil> 802-11-wireless.bssid <BSSID>`) y reconecta. Volver a **Automático** lo quita.
- Los cambios provocados por la propia extensión no cuentan como rebote.
- **El punto fijo se suelta solo** para no dejarte atrapado en uno lejano:
  - al suspender el equipo (y como respaldo al reanudar),
  - si quedas desconectado y el punto fijado ya no se alcanza (reintenta cada N segundos),
  - si el punto fijado se vuelve débil y otro de la misma red se ve claramente mejor.
- **Conectarte a otras redes** desde el mismo menú: las guardadas se activan directo; las nuevas piden la contraseña con el diálogo de GNOME (las marcadas con 🔒 son protegidas).
- Opción "Probar ícono de rebote (8 s)" para ver cómo se vería.

### 5. Configuración visual
Ventana de preferencias (Extensiones → Ping Indicator ⚙) con tres pestañas:

| Pestaña | Qué ajusta |
|---|---|
| General | Dirección del router, servidor de internet, intervalos (normal y con problemas), mostrar/ocultar la latencia junto al ícono |
| Umbrales | Latencia "bueno" y "medio" (ms) para el router y para internet |
| Estabilidad | Pings por ráfaga; pérdida y jitter que marcan inestabilidad (router e internet); diagnóstico mtr (activar y espera); confirmaciones de cambio de estado y de corte total; Wi-Fi (vigilar saltos, saltos para avisar, ventana, soltar el punto fijo al suspender / cuando deje de servir / espera) |

## Instalación

```bash
git clone https://github.com/patriciorangles/gnome-shell-extension-ping-indicator.git
cd gnome-shell-extension-ping-indicator
./install.sh
```

Luego **cierra sesión y vuelve a entrar** (en Wayland no se puede recargar la shell con Alt+F2 → r).

### Dependencias
- `ping` (iputils) y `mtr` para las mediciones y el diagnóstico.
- NetworkManager (la parte Wi-Fi usa `libnm` vía GJS).
- GTK 4 / libadwaita para la ventana de preferencias.

## Estructura

| Archivo | Contenido |
|---|---|
| `extension.js` | Interfaz del panel, menús, ciclo de medición |
| `netcheck.js` | Ping, mtr, estadísticas, antirrebote de estados |
| `wifi.js` | Integración con NetworkManager (fijar, soltar, conectar) |
| `wifi-logic.js` | Reglas Wi-Fi puras: agrupar equipos, rebote, cuándo soltar el punto fijo |
| `prefs.js` | Ventana de preferencias |
| `schemas/` | Claves GSettings |
| `icons/` | Íconos del panel |
| `test-*.js` | Pruebas |

## Pruebas

Sin necesidad de GNOME Shell:

```bash
gjs -m test-logic.js
gjs -m test-netcheck.js
gjs -m test-wifi.js     # incluye lecturas reales de NetworkManager (solo lectura)
```
