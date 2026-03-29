#!/bin/bash
set -e

echo "============================================"
echo "  SNIPR REDIRECT SERVER - Setup"
echo "  For custom domain redirects only"
echo "============================================"

if [ "$EUID" -ne 0 ]; then
  echo "Run as root: sudo bash deploy.sh"
  exit 1
fi

# Install Node.js if needed
if ! command -v node &> /dev/null; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi

# Install dependencies
echo "Installing dependencies..."
npm install --production

# Build
echo "Building..."
npx tsc

# Setup .env
if [ ! -f .env ]; then
  echo ""
  echo "============================================"
  echo "  CONFIGURATION"
  echo "============================================"
  read -p "Main Snipr server database IP (e.g., 104.218.51.234): " DB_IP
  read -p "Database password: " DB_PASS
  read -p "Main Snipr domain (e.g., snipr.sh): " SNIPR_DOMAIN
  
  cat > .env << EOF
DATABASE_URL=postgresql://snipr_user:${DB_PASS}@${DB_IP}:5432/snipr_prod
PORT=8080
SNIPR_URL=https://${SNIPR_DOMAIN}
LOG_LEVEL=info
EOF
  echo ".env created!"
fi

# Create systemd service
cat > /etc/systemd/system/snipr-redirect.service << EOF
[Unit]
Description=Snipr Redirect Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$(pwd)
EnvironmentFile=$(pwd)/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Install Nginx
apt install -y nginx

# Nginx catch-all config
cat > /etc/nginx/sites-available/snipr-redirect << 'NGINXEOF'
server {
    listen 80 default_server;
    listen 443 ssl default_server;
    server_name _;

    # Self-signed fallback cert (replace with real certs per domain)
    ssl_certificate /etc/nginx/ssl/default.crt;
    ssl_certificate_key /etc/nginx/ssl/default.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
NGINXEOF

# Generate self-signed fallback cert
mkdir -p /etc/nginx/ssl
if [ ! -f /etc/nginx/ssl/default.crt ]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/default.key \
    -out /etc/nginx/ssl/default.crt \
    -subj "/CN=snipr-redirect" 2>/dev/null
fi

ln -sf /etc/nginx/sites-available/snipr-redirect /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Start service
systemctl daemon-reload
systemctl enable snipr-redirect
systemctl start snipr-redirect

echo ""
echo "============================================"
echo "  SNIPR REDIRECT SERVER DEPLOYED!"
echo "============================================"
echo ""
echo "  Health: curl http://localhost:8080/health"
echo ""
echo "  IMPORTANT: Configure PostgreSQL on main"
echo "  server to allow connections from this IP."
echo "  Edit: /etc/postgresql/*/main/pg_hba.conf"
echo "  Add:  host snipr_prod snipr_user THIS_SERVER_IP/32 md5"
echo "  Then: systemctl reload postgresql"
echo ""
echo "============================================"
