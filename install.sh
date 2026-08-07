#!/usr/bin/env bash
set -euo pipefail

# install.sh — Setup custom-pi extensions & configuration templates

PI_AGENT_DIR="${HOME}/.pi/agent"
PI_EXTENSIONS_DIR="${PI_AGENT_DIR}/extensions"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Custom Pi Installer ==="
mkdir -p "${PI_EXTENSIONS_DIR}"

echo "[+] Copying extensions to ${PI_EXTENSIONS_DIR}..."
cp -fv "${SCRIPT_DIR}/extensions/"*.ts "${PI_EXTENSIONS_DIR}/"

echo "[+] Installing helper scripts to ${HOME}/.local/bin..."
mkdir -p "${HOME}/.local/bin"
cp -fv "${SCRIPT_DIR}/scripts/"* "${HOME}/.local/bin/"
chmod +x "${HOME}/.local/bin/"*

if [ ! -f "${PI_AGENT_DIR}/settings.json" ]; then
    echo "[+] Creating settings.json from template..."
    cp -v "${SCRIPT_DIR}/config/settings.json.example" "${PI_AGENT_DIR}/settings.json"
else
    echo "[!] Existing ${PI_AGENT_DIR}/settings.json found. Preserving."
fi

if [ ! -f "${PI_AGENT_DIR}/models.json" ]; then
    echo "[+] Creating models.json from template..."
    cp -v "${SCRIPT_DIR}/config/models.json.example" "${PI_AGENT_DIR}/models.json"
else
    echo "[!] Existing ${PI_AGENT_DIR}/models.json found. Preserving."
fi

if [ ! -f "${HOME}/.pi/web-search.json" ]; then
    echo "[+] Creating web-search.json from template..."
    cp -v "${SCRIPT_DIR}/config/web-search.json.example" "${HOME}/.pi/web-search.json"
else
    echo "[!] Existing ${HOME}/.pi/web-search.json found. Preserving."
fi

echo "=== Done! Custom Pi extensions installed successfully. ==="
