#!/usr/bin/env bash
# Empaqueta la Lambda en dist/function.zip (Node.js, sin frameworks).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
DIST="$ROOT/dist"

rm -rf "$BUILD" "$DIST"
mkdir -p "$BUILD" "$DIST"

echo ">> Instalando dependencias de producción"
cp "$ROOT/package.json" "$BUILD/"
[ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$BUILD/"
( cd "$BUILD" && npm install --omit=dev --no-audit --no-fund --silent )

echo ">> Copiando código + .env"
cp -r "$ROOT/src" "$BUILD/src"
[ -f "$ROOT/.env" ] && cp "$ROOT/.env" "$BUILD/.env"

echo ">> Generando zip"
find "$BUILD" -name '*.map' -delete 2>/dev/null || true
rm -f "$DIST/function.zip"

# Busca un Python que realmente funcione (evita el stub de Microsoft Store).
PY=""
for c in "${PYTHON_BIN:-}" python3 python py; do
  [ -n "$c" ] || continue
  if "$c" -c 'import zipfile' >/dev/null 2>&1; then PY="$c"; break; fi
done

if command -v zip >/dev/null 2>&1; then
  ( cd "$BUILD" && zip -qr9 "$DIST/function.zip" . )
elif [ -n "$PY" ]; then
  "$PY" - "$BUILD" "$DIST/function.zip" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _dirs, files in os.walk(src):
        for f in files:
            fp = os.path.join(root, f)
            z.write(fp, os.path.relpath(fp, src))
PY
elif command -v powershell >/dev/null 2>&1; then
  powershell -NoProfile -Command "Compress-Archive -Path '$(cygpath -w "$BUILD")\*' -DestinationPath '$(cygpath -w "$DIST/function.zip")' -Force"
else
  echo "No hay 'zip', ni Python, ni PowerShell para empaquetar. En Windows usa deploy\\build.ps1."; exit 1
fi

[ -f "$DIST/function.zip" ] || { echo "ERROR: no se generó el zip."; exit 1; }

UNZIP=$(du -sm "$BUILD" | cut -f1)
ZIPPED=$(du -m "$DIST/function.zip" | cut -f1)
echo ">> Listo: dist/function.zip (zip ${ZIPPED} MB | descomprimido ${UNZIP} MB)"
