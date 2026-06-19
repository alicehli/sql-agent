#!/bin/bash
# Deploy/update script for sql-agent
# Usage: ./deploy.sh [--skip-build]
set -e

APP_DIR="${APP_DIR:-$HOME/app}"

echo "=============================================="
echo "  SQL Agent - Deploy"
echo "=============================================="

# Check for Claude auth
echo ""
echo "=== Checking Claude authentication ==="
if [ ! -f "$HOME/.claude/credentials.json" ] && [ ! -f "$HOME/.claude.json" ]; then
    echo "WARNING: Claude CLI not authenticated!"
    echo "Run: claude /login"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "Claude auth found"
fi

# Clone or update repo
echo ""
echo "=== Updating code ==="
if [ ! -d "$APP_DIR" ]; then
    echo "Cloning repository..."
    git clone git@github.com:s23h/sql-agent.git "$APP_DIR"
else
    echo "Pulling latest changes..."
    cd "$APP_DIR"
    git pull
fi

# Install dependencies
echo ""
echo "=== Installing dependencies ==="
cd "$APP_DIR"
pnpm install

# Build (unless skipped)
if [ "$1" != "--skip-build" ]; then
    echo ""
    echo "=== Building ==="
    pnpm run build
fi

# Setup environment file if needed
if [ ! -f ".env" ]; then
    echo ""
    echo "=== Creating .env file ==="
    cat > .env << 'EOF'
# Required: TextQL Sandcastle API for sandboxes
SANDBOX_BASE_URL=https://app.textql.com
SANDBOX_API_KEY=your-sandcastle-key-here

# Optional: Override max tokens
CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000

# Server port (nginx proxies to this)
PORT=3000
EOF
    echo "Created .env - please edit with your Sandcastle API key!"
    echo "Run: nano $APP_DIR/.env"
fi

# Create logs directory
mkdir -p logs

# Configure nginx
echo ""
echo "=== Configuring nginx ==="
sudo tee /etc/nginx/sites-available/sql-agent > /dev/null << 'EOF'
upstream sql_agent {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://sql_agent;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/sql-agent /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Start/restart with PM2
echo ""
echo "=== Starting application ==="
pm2 delete sql-agent 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

# Setup PM2 to start on boot
echo ""
echo "=== Configuring PM2 startup ==="
pm2 startup systemd -u $USER --hp $HOME 2>/dev/null | grep -E "sudo.*systemctl" | bash 2>/dev/null || true

echo ""
echo "=============================================="
echo "  Deployment complete!"
echo "=============================================="
echo ""
echo "Status: $(pm2 list | grep sql-agent | awk '{print $12}')"
echo ""
echo "Useful commands:"
echo "  pm2 logs sql-agent    # View logs"
echo "  pm2 restart sql-agent # Restart app"
echo "  pm2 status            # Check status"
