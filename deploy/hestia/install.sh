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
exec 9>/run/lock/jrcare-install.lock
flock -x 9
revision=$(git -C "$checkout" rev-parse --verify HEAD)
release="$app_dir/releases/$revision"
install -d -m 0755 "$app_dir" "$app_dir/releases"
install -d -m 0750 /etc/jrcare
stage=$(mktemp -d "$app_dir/.install.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT

node_bin=$(command -v node || true)
if [[ "$node_bin" != /* ]] || ! "$node_bin" -e 'if (parseInt(process.versions.node) < 24) process.exit(1); require("node:sqlite")' >/dev/null 2>&1; then
  node_version=v24.22.3
  # Published at https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
  case "$(uname -m)" in
    x86_64)
      node_arch=x64
      checksum=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
      ;;
    aarch64)
      node_arch=arm64
      checksum=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c
      ;;
    *)
      printf '%s\n' 'Arsitektur memerlukan Node.js 24+ system-wide yang menyediakan node:sqlite.' >&2
      exit 1
      ;;
  esac
  node_build="node-$node_version-linux-$node_arch"
  runtime="$app_dir/runtime/$node_build"
  node_bin="$runtime/bin/node"
  if [[ ! -d "$runtime" ]]; then
    install -d -m 0755 "$app_dir/runtime" "$stage/runtime"
    archive="$stage/$node_build.tar.xz"
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 2 \
      --connect-timeout 10 --max-time 180 -o "$archive" "https://nodejs.org/dist/$node_version/$node_build.tar.xz"
    if ! printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status; then
      printf '%s\n' 'Checksum arsip Node.js tidak cocok dengan rilis resmi.' >&2
      exit 1
    fi
    tar -xJf "$archive" -C "$stage/runtime" --strip-components=1 -- "$node_build/bin/node" "$node_build/LICENSE"
    "$stage/runtime/bin/node" -e 'require("node:sqlite")'
    mv -T -- "$stage/runtime" "$runtime"
  fi
fi
runtime_version=$("$node_bin" --version)
printf 'Runtime JRCare %s dari %s\n' "$runtime_version" "$node_bin"

if [[ ! -d "$release" ]]; then
  install -d -m 0755 "$stage/release"
  git -C "$checkout" archive "$revision" -- server.mjs store.mjs rules.mjs routing.mjs workflow.mjs public \
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
previous=$(readlink "$app_dir/current" || true)
previous_node=$(readlink "$app_dir/node" || true)
switch_link() {
  local target=$1 name=$2
  ln -s -- "$target" "$stage/$name"
  mv -Tf -- "$stage/$name" "$app_dir/$name"
}
switch_link "$node_bin" node
switch_link "$release" current

healthy=0
if systemctl daemon-reload && systemctl restart "$unit"; then
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
  if [[ -n "$previous" && ( "$previous" != "$release" || "$previous_node" != "$node_bin" ) ]]; then
    if [[ -n "$previous_node" ]]; then switch_link "$previous_node" node; fi
    switch_link "$previous" current
    systemctl restart "$unit" || true
  else
    systemctl stop "$unit" || true
  fi
  printf '%s\n' 'JRCare gagal memenuhi pemeriksaan kesehatan. Periksa sudo journalctl -u jrcare -n 80.' >&2
  exit 1
fi

systemctl enable "$unit"
printf '%s\n' "JRCare $revision berjalan di 127.0.0.1:7310." \
  "Pilih template jrcare-node untuk $domain di Hestia, lalu uji HTTPS sesuai panduan."
