#!/usr/bin/env bash
# Copy the app to the VPS, install production dependencies and restart the service.
# Usage: deploy/deploy.sh ubuntu@YOUR_SERVER_IP
set -euo pipefail
target="${1:?usage: deploy/deploy.sh user@host}"
cd "$(dirname "$0")/.."
rsync -az --delete --rsync-path="sudo rsync" src public deploy package.json package-lock.json "$target:/opt/trading-lab/"
ssh "$target" 'set -e
  cd /opt/trading-lab
  sudo npm ci --omit=dev --no-audit --no-fund
  sudo install -o root -g root -m 0644 deploy/trading-lab.service deploy/trading-lab-backup.service deploy/trading-lab-backup.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now trading-lab-backup.timer
  sudo systemctl restart trading-lab
  sleep 2
  systemctl is-active trading-lab'
