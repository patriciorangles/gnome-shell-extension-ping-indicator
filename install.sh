#!/bin/bash

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/ping-indicator@patriciorangles"

# Crear directorios necesarios
mkdir -p "$EXT_DIR/schemas"

# Copiar archivos
# stylesheet.css también: sin él los estilos (tamaño del número, espacios) no
# se aplican y el widget se ve con los valores por defecto del panel.
cp extension.js netcheck.js wifi.js wifi-logic.js metadata.json prefs.js stylesheet.css "$EXT_DIR/"
# rm+cp (no solo cp -r) para que los íconos que ya no existen en el repo
# no se queden colgados en la instalación de versiones anteriores.
rm -rf "$EXT_DIR/icons"
cp -r icons "$EXT_DIR/"
cp schemas/*.xml "$EXT_DIR/schemas/"

# Compilar esquemas
glib-compile-schemas "$EXT_DIR/schemas/"

# Establecer permisos
chmod -R a+rX "$EXT_DIR"

echo "Extensión instalada correctamente!"
echo "Recarga GNOME con Alt+F2 -> r"