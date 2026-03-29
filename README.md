# Snipr Redirect Server

Lightweight redirect server for custom domain short links. Runs on a separate IP from the main Snipr app for security isolation.

## What it does

- Serves branded landing page when visiting custom domain root (e.g., `cryptomails.world/`)
- Redirects short links (e.g., `cryptomails.world/my-link` → destination)
- Tracks clicks with geo/device/browser data
- Shows branded 404 for invalid slugs
- Caches domain lookups (5 min TTL)

## Architecture

```
Main Server (104.218.51.234)     Redirect Server (163.245.216.153)
┌──────────────────────┐         ┌──────────────────────┐
│  Snipr App           │         │  snipr-redirect      │
│  - Dashboard         │         │  - Redirects only    │
│  - API               │         │  - Landing pages     │
│  - Admin Panel       │         │  - Click tracking    │
│  - PostgreSQL DB  ◄──┼─────────┤  - Reads from DB    │
└──────────────────────┘         └──────────────────────┘
```

Users point their custom domains (A record / CNAME) to 163.245.216.153.
The redirect server connects to the SAME database on the main server.

## Setup

```bash
# On the redirect server (163.245.216.153)
git clone https://github.com/absaii50/snipr-redirect.git /var/www/snipr-redirect
cd /var/www/snipr-redirect
sudo bash deploy.sh
```

The deploy script will:
1. Install Node.js 22
2. Install dependencies and build
3. Ask for database connection details
4. Create systemd service (auto-restart)
5. Configure Nginx as reverse proxy

## IMPORTANT: Database Access

The main server's PostgreSQL must allow connections from this server.

On the **main server** (104.218.51.234):

```bash
# Allow redirect server to connect
echo "host snipr_prod snipr_user 163.245.216.153/32 md5" >> /etc/postgresql/*/main/pg_hba.conf
systemctl reload postgresql

# Also open PostgreSQL port in firewall
ufw allow from 163.245.216.153 to any port 5432
```

## Useful Commands

```bash
systemctl status snipr-redirect    # Check status
systemctl restart snipr-redirect   # Restart
journalctl -u snipr-redirect -n 50 # View logs
curl http://localhost:8080/health   # Health check
```
