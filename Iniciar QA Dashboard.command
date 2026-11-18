#!/bin/bash
# Lanzador para macOS: doble clic para instalar (la primera vez), compilar y abrir la app.
cd "$(dirname "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  echo "No se encontró Node.js. Instálalo desde https://nodejs.org (versión 20 o superior)."
  read -r -p "Enter para cerrar..."
  exit 1
fi
[ -d node_modules ] || npm install || exit 1
exec npm start
