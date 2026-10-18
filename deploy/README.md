# Private deployment (Phase 1: live paper on a VPS)

This runs one Node 24 service: the dashboard, the paper ledger and the live Kite price feed. Orders are simulated; nothing is sent to the broker. The design is in [the Phase 1 spec](../docs/superpowers/specs/2026-10-17-phase1-live-paper-design.md).

**Status:** written against the code, not yet run on a real VPS. The first deploy is Task 10 of the [Phase 1 plan](../docs/superpowers/plans/2026-10-17-phase1-live-paper.md).

## 1. What you buy (checked 17 October 2026)

| Item | Cost | Notes |
|---|---|---|
| Kite Connect app, **Connect (paid)** tier | ₹500/month per app | The free Personal tier has no live or historical data. [Pricing](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/historical-data-and-live-market-data-payment-plan) |
| AWS Lightsail Linux, **1 GB** plan, Mumbai region | $7/month | Static IP included, which Zerodha requires for API orders in a later live stage. [Pricing](https://aws.amazon.com/lightsail/pricing/) |

Taxes and any model calls are extra. Recheck both prices before buying.

## 2. Kite Connect app

1. Sign in at [developers.kite.trade](https://developers.kite.trade) with your Zerodha account and create an app of type **Connect**.
2. Set the redirect URL to exactly `http://127.0.0.1:3000/kite/callback`. Through the SSH tunnel, that address reaches the VPS.
3. Pay the subscription. Keep the **API key** and **API secret**. They go only into `/etc/trading-lab.env` on the VPS, never chat, Git or screenshots.

## 3. VPS setup

Create a Lightsail instance in **Mumbai** with **Ubuntu 24.04** on the 1 GB plan, attach the static IP it offers, and limit the firewall to SSH (port 22) from your own address. Then on the VPS:

```sh
sudo apt-get update && sudo apt-get install -y rsync curl
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt-get install -y nodejs
node --version   # must print v24 or later
sudo ufw allow 22/tcp && sudo ufw --force enable
sudo useradd --system --home-dir /var/lib/trading-lab --shell /usr/sbin/nologin trading-lab
sudo install -d -o root -g root -m 0755 /opt/trading-lab
sudo install -d -o trading-lab -g trading-lab -m 0700 /var/lib/trading-lab
```

Create the environment file (root-only):

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/trading-lab.env
sudoedit /etc/trading-lab.env
```

with:

```sh
KITE_API_KEY=your_api_key
KITE_API_SECRET=your_api_secret
TRADING_LAB_HOST=127.0.0.1
TRADING_LAB_PORT=3000
TRADING_LAB_DB_PATH=/var/lib/trading-lab/trading-lab.sqlite
TRADING_LAB_ALLOW_PAID_MODEL_CALLS=0
```

## 4. Deploy

From your laptop, in the project folder:

```sh
deploy/deploy.sh ubuntu@YOUR_STATIC_IP
```

It copies `src`, `public` and `deploy`, runs `npm ci --omit=dev`, installs the service and backup timer, restarts the service and prints `active` on success. Run it again for every update.

## 5. Daily login (every trading morning, before 09:15 IST)

Kite tokens for personal apps expire at 06:00 IST and cannot be refreshed automatically.

```sh
ssh -N -L 3000:127.0.0.1:3000 ubuntu@YOUR_STATIC_IP
```

Open `http://127.0.0.1:3000`. The Broker connection panel shows **Login needed**. Click **Login to Kite**, complete the Zerodha login and TOTP, and you land back on the dashboard with the session valid until 06:00 IST the next day. You can close the tunnel afterwards; the service keeps running.

Until you log in, the bot opens no new paper positions. Weekends and NSE holidays need no login.

## 6. What runs where

| Path | Contents |
|---|---|
| `/opt/trading-lab` | Application code (root-owned, read-only to the service) |
| `/var/lib/trading-lab/trading-lab.sqlite` | Paper ledger, settings, Kite session, daily reports |
| `/var/lib/trading-lab/ticks/ticks-YYYY-MM-DD.jsonl` | Every tick received, written before use; replays a day exactly |
| `/var/lib/trading-lab/backups/` | Daily copies at 16:00 IST on weekdays, kept 30 days |
| `/etc/trading-lab.env` | Secrets (root-only) |

Logs: `sudo journalctl -u trading-lab --since today`. Backups: `sudo journalctl -u trading-lab-backup`.

## 7. Restore a backup

```sh
sudo systemctl stop trading-lab
sudo -u trading-lab cp /var/lib/trading-lab/backups/trading-lab-YYYY-MM-DD.sqlite /var/lib/trading-lab/trading-lab.sqlite
sudo rm -f /var/lib/trading-lab/trading-lab.sqlite-wal /var/lib/trading-lab/trading-lab.sqlite-shm
sudo systemctl start trading-lab
```

The service starts paused until it has reloaded state; log in again if the restored session has expired. Test a restore once before Phase 1 day 1.

## 8. Before Phase 1 day 1: manual check

1. `systemctl is-active trading-lab` prints `active`.
2. Tunnel in, log in to Kite, panel shows the session as valid.
3. During market hours: panel shows **Live** with the last tick updating; after one bar (15 minutes) a decision appears in the journal.
4. `sudo systemctl restart trading-lab`, reload the dashboard: state restored, feed back to **Live** without a new login.
5. `ls /var/lib/trading-lab/ticks/` shows today's file; `sudo systemctl start trading-lab-backup` writes a backup.
6. Restore that backup once (section 7).

Record the result in [the resume plan](../docs/RESUME-PLAN.md).

## Restarts and failures

systemd restarts a crashed process up to five times a minute. A storage failure stops the live feed and exits so the service restarts paused. A restart never re-places anything with a broker: in Phase 1 there is nothing to re-place. Review repeated failures in the journal before restarting by hand.

The dashboard has no authentication. Never open port 3000 in the firewall; use the SSH tunnel.

## Model access

Settings select `rules`, `openai`, or `anthropic` and a model ID. No model is selected implicitly for a paid provider. The server calls only the official fixed provider endpoints and enforces its review budget before calling the adapter. Model reviews cannot change order quantity, exposure limits or broker permissions.

Request formats follow [OpenAI Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [Anthropic Messages structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Choose a model available to your account that supports the corresponding format. Unsupported models or malformed/refused/incomplete responses produce an error; they are not silently replaced by another provider or a rules result. Provider responses are checked locally as well.

### Expert book: Claude subscription (Phase 1b)

The expert paper book calls the Claude Code CLI in print mode (`claude -p`) under your Claude Max subscription. No API key is involved, and marginal model cost is ₹0 under the subscription. The design is in [the Phase 1b spec](../docs/superpowers/specs/2026-10-18-phase1b-expert-shadow-design.md).

1. **On your Mac**, run `claude setup-token` and sign in with your own Claude account. It prints a one-year OAuth token. Do not paste it into chat, Git or screenshots.
2. **On the VPS**, add one line to `/etc/trading-lab.env` with `sudoedit`: `CLAUDE_CODE_OAUTH_TOKEN=<the token>`. Keep the file at mode 0600, root-owned.
3. **No `ANTHROPIC_API_KEY` may exist** in `/etc/trading-lab.env`, the service user's environment or any profile file. In print mode a key silently takes precedence over the subscription token and would bill the API. Check with `sudo grep -l ANTHROPIC_API_KEY /etc/trading-lab.env /etc/environment` (it names matching files without printing a key; no output is correct) and with `systemctl show trading-lab -p Environment | grep -c ANTHROPIC_API_KEY`, which checks the unit's `Environment=` lines (`0` is correct).
4. **The CLI comes with the app.** `package.json` pins `@anthropic-ai/claude-code` at 2.1.302 (tested live on 18 October 2026; Opus 5.5 needs 2.1.280 or newer), so `npm ci` in the deploy installs it at `/opt/trading-lab/node_modules/.bin/claude` and the bot uses that copy. No global install is needed. Upgrade by changing the pin, testing on the Mac, then deploying.
5. **Verify as the service user** without putting the token on a command line or in shell history. In a root shell, the token is loaded from the env file:

   ```sh
   sudo -i
   set -a; . /etc/trading-lab.env; set +a
   echo 'Say ok' | sudo -u trading-lab --preserve-env=CLAUDE_CODE_OAUTH_TOKEN /opt/trading-lab/node_modules/.bin/claude -p --output-format json --tools ""
   exit
   ```

   The JSON result should contain `ok` and `"is_error":false`. Send the prompt on stdin as shown: `--tools ""` would otherwise take a prompt argument as a tool name. Do not use `sudo env CLAUDE_CODE_OAUTH_TOKEN=...`; that records the token.
6. In the dashboard, Configuration section 05, tick **Run the expert book**, and apply. It takes effect at the next service restart: `sudo systemctl restart trading-lab`. The Expert panel then shows **Running**.

**The token is a one-year credential tied to your personal Claude account.** If the VPS may be compromised, revoke it at once in your claude.ai account settings (sign out of or revoke the Claude Code session there), then remove the line from `/etc/trading-lab.env` and restart the service. Revocation pauses the expert layer only; protective exits and the rules book never depend on it. Expect to repeat `claude setup-token` yearly.

Before the first Phase 1b session, run one manual check: the hello call above works, a research pass writes records, a thesis appears in the Expert panel, and setting the daily call limit to 1 shows a suppression in the panel.
