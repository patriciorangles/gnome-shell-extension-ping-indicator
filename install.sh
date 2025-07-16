#!/bin/bash

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/ping-indicator@patriciorangles"

# Crear directorios necesarios
mkdir -p "$EXT_DIR/schemas"

# Copiar archivos
cp extension.js metadata.json prefs.js "$EXT_DIR/"
cp -r icons "$EXT_DIR/"
cp schemas/*.xml "$EXT_DIR/schemas/"

# Compilar esquemas
glib-compile-schemas "$EXT_DIR/schemas/"

# Establecer permisos
chmod -R a+rX "$EXT_DIR"

echo "Extensión instalada correctamente!"
echo "Recarga GNOME con Alt+F2 -> r"