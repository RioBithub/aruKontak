#!/usr/bin/env bash
set -euo pipefail

app_dir=/opt/jrcare
settings=/etc/jrcare/jrcare.env
templates=/usr/local/hestia/data/templates/web/nginx
domain=helpdesk-jrcare.aruraharja.co.id
unit=jrcare.service
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
checkout=$(cd -- "$source_dir/../.." && pwd)

if (( EUID != 0 )); then
  printf '%s\n' 'Jalankan installer dengan sudo di VPS HestiaCP.' >&2
  exit 1
fi
if [[ ! -d "$templates" || ! -x /usr/local/hestia/bin/v-list-web-domain ]]; then
  printf '%s\n' 'Instalasi HestiaCP dengan Nginx tidak ditemukan di /usr/local/hestia.' >&2
  exit 1
fi
node_bin=$(command -v node || true)
if [[ "$node_bin" != /* ]] || ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  printf '%s\n' 'Pasang Node.js 24 atau lebih baru secara system-wide di VPS.' >&2
  exit 1
fi

exec 9>/run/lock/jrcare-install.lock
flock -x 9
revision=$(git -C "$checkout" rev-parse --verify HEAD)
release="$app_dir/releases/$revision"
install -d -m 0755 "$app_dir" "$app_dir/releases"
install -d -m 0750 /etc/jrcare
stage=$(mktemp -d "$app_dir/.install.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT

if [[ ! -d "$release" ]]; then
  install -d -m 0755 "$stage/release"
  git -C "$checkout" archive "$revision" -- server.mjs store.mjs rules.mjs routing.mjs public \
    | tar -x -C "$stage/release"
  "$node_bin" --check "$stage/release/server.mjs"
  mv -- "$stage/release" "$release"
fi

if [[ ! -e "$settings" ]]; then
  config=$(mktemp /etc/jrcare/.env.XXXXXXXX)
  token=$("$node_bin" -p 'require("node:crypto").randomBytes(24).toString("hex")')
  printf '%s\n' NODE_ENV=production HOST=127.0.0.1 PORT=7310 \
    "JRCARE_ORIGIN=https://$domain" JRCARE_TRUST_PROXY=1 \
    JRCARE_DATABASE=/var/lib/jrcare/jrcare.sqlite "JRCARE_SETUP_TOKEN=$token" > "$config"
  unset token
  mv -- "$config" "$settings"
fi

install -m 0644 "$source_dir/jrcare-upstream.inc" "$templates/jrcare-upstream.inc"
for target in "$templates" "$templates/php-fpm"; do
  [[ -d "$target" ]] || continue
  if [[ "$target" == "$templates" ]]; then
    http_port='%proxy_port%'
    https_port='%proxy_ssl_port%'
  else
    http_port='%web_port%'
    https_port='%web_ssl_port%'
  fi
  sed "s/@HTTP_PORT@/$http_port/g" "$source_dir/jrcare-node.tpl" > "$stage/jrcare-node.tpl"
  sed "s/@HTTPS_PORT@/$https_port/g" "$source_dir/jrcare-node.stpl" > "$stage/jrcare-node.stpl"
  install -m 0644 "$stage/jrcare-node.tpl" "$stage/jrcare-node.stpl" "$target/"
done

install -m 0644 "$source_dir/jrcare.service" "/etc/systemd/system/$unit"
ln -s -- "$node_bin" "$stage/node"
mv -Tf -- "$stage/node" "$app_dir/node"
previous=$(readlink "$app_dir/current" || true)
switch_release() {
  ln -s -- "$1" "$stage/current"
  mv -Tf -- "$stage/current" "$app_dir/current"
}
switch_release "$release"
systemctl daemon-reload

healthy=0
if systemctl restart "$unit"; then
  for ((attempt = 1; attempt <= 12; attempt++)); do
    if systemctl is-active --quiet "$unit" \
        && curl --fail --silent --max-time 2 http://127.0.0.1:7310/healthz | grep -qxF '{"status":"ok","service":"jrcare"}'; then
      healthy=1
      break
    fi
    sleep 1
  done
fi

if (( ! healthy )); then
  if [[ -n "$previous" && "$previous" != "$release" ]]; then
    switch_release "$previous"
    systemctl restart "$unit"
  else
    systemctl stop "$unit"
  fi
  printf '%s\n' 'JRCare gagal memenuhi pemeriksaan kesehatan. Periksa sudo journalctl -u jrcare -n 80.' >&2
  exit 1
fi

systemctl enable "$unit"
printf '%s\n' "JRCare $revision berjalan di 127.0.0.1:7310." \
  "Pilih template jrcare-node untuk $domain di Hestia, lalu uji HTTPS sesuai panduan."
