# Private deployment

> **Unverified deployment draft:** the local paper dashboard now has its server and browser controller, but these deployment templates have not been built or deployed. Read [the current checkpoint](../docs/RESUME-PLAN.md) before using them. No cloud purchase or deployment is authorized.

This runs the lightweight Node 24 dashboard, synthetic market and paper ledger in one process. It does not launch the optional eve development runtime, connect a broker, or enable real trading. Deployments and account purchases require the owner's action; these files do not provision anything.

The dashboard has no public authentication. Keep its host port on `127.0.0.1` and use SSH forwarding. Add authentication and TLS before considering public access.

## Lightsail size and cost

As checked on 13 October 2026, [AWS Lightsail's Linux/Unix public-IPv4 bundles](https://aws.amazon.com/lightsail/pricing/) list **$5/month for 0.5 GB memory** and **$7/month for 1 GB**. The $5 plan is a starting point for this small, single-service lab, not a measured capacity guarantee. Monitor memory; use the 1 GB plan if the workload needs it. Model API usage, taxes, backups and any future market-data/broker API subscriptions cost extra. No local LLM or heavy backtesting engine runs on this VM.

## Node service on Linux

Install an official Node 24 LTS build first and confirm `/usr/bin/node --version` reports v24 or later. Adjust `ExecStart` if your binary is elsewhere. Copy the application's `src/` and `public/` directories to `/opt/trading-lab`; the service does not need the eve packages or `node_modules`.

Run these setup commands on the chosen host as its administrator:

```sh
sudo useradd --system --home-dir /var/lib/trading-lab --shell /usr/sbin/nologin trading-lab
sudo install -d -o root -g root -m 0755 /opt/trading-lab
sudo install -o root -g root -m 0644 deploy/trading-lab.service /etc/systemd/system/trading-lab.service
sudo install -o root -g root -m 0600 .env.example /etc/trading-lab.env
sudoedit /etc/trading-lab.env
```

In `/etc/trading-lab.env`, keep `TRADING_LAB_HOST=127.0.0.1` and set `TRADING_LAB_DB_PATH=/var/lib/trading-lab/trading-lab.sqlite`. Enter only the provider key you intend to use, or leave both blank for rules mode. The service runs unprivileged; its SQLite database lives outside the application release directory. Restrict inbound firewall access to SSH from your own address; leave port 3000 closed.

After the app files are copied:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now trading-lab
sudo systemctl status trading-lab
sudo journalctl -u trading-lab --since today
```

From your own computer, replacing the user and address with those of your VM:

```sh
ssh -N -L 3000:127.0.0.1:3000 ubuntu@YOUR_SERVER_IP
```

Open `http://127.0.0.1:3000` locally. Keep that SSH connection open while using the dashboard. The VM does not require a public dashboard port.

The restart policy recovers a failed process with a bounded restart rate. It preserves the database; it does not imply that a future real broker position has been reconciled. Review repeated failures before restarting again. Before replacing app files or backing up the ledger, stop the service and copy the whole data directory, including any SQLite WAL/SHM files; then restart. Keep backup access private and test restore separately.

## Optional container

Docker adds overhead on a 0.5 GB VM, so the direct Node service is the lighter option. The container deliberately binds internally to `0.0.0.0` so port publishing works; the host publication must remain loopback-only.

From the project root:

```sh
docker build -f deploy/Dockerfile -t trading-lab .
docker volume create trading-lab-data
docker run -d --name trading-lab --restart on-failure:5 --env-file .env \
  -e TRADING_LAB_HOST=0.0.0.0 \
  -e TRADING_LAB_DB_PATH=/data/trading-lab.sqlite \
  -p 127.0.0.1:3000:3000 \
  -v trading-lab-data:/data trading-lab
```

Create `.env` from `.env.example` first; real keys stay outside the image. A named volume persists data across container replacement. Use the same SSH forwarding command for remote access. Do not run the systemd service and container on port 3000 simultaneously.

## Model access

Settings select `rules`, `openai`, or `anthropic` and a model ID. No model is selected implicitly for a paid provider. The server calls only the official fixed provider endpoints and enforces its review budget before calling the adapter. Model reviews cannot change order quantity, exposure limits or broker permissions.

Request formats follow [OpenAI Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [Anthropic Messages structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Choose a model available to your account that supports the corresponding format. Unsupported models or malformed/refused/incomplete responses produce an error; they are not silently replaced by another provider or a rules result. Provider responses are checked locally as well.
