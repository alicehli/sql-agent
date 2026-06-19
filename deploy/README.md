# Deploying sql-agent to GCP

## Quick Start (GCP VM)

### 1. Create VM
```bash
# Create a small VM (e2-small is ~$15/mo)
gcloud compute instances create sql-agent \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB \
  --tags=http-server,https-server

# Allow HTTP/HTTPS traffic
gcloud compute firewall-rules create allow-http --allow tcp:80 --target-tags=http-server
gcloud compute firewall-rules create allow-https --allow tcp:443 --target-tags=https-server
```

### 2. SSH into VM
```bash
gcloud compute ssh sql-agent --zone=us-central1-a
```

### 3. Run setup script
```bash
# Download and run setup
curl -fsSL https://raw.githubusercontent.com/s23h/sql-agent/main/deploy/gcp-setup.sh | bash

# Or manually:
sudo apt-get update
sudo apt-get install -y curl git nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm@10.19.0 pm2
```

### 4. Clone and build
```bash
# Clone repo
cd ~
git clone git@github.com:s23h/sql-agent.git app
cd app

# Install dependencies
pnpm install

# Build
pnpm run build
```

### 5. Configure environment
```bash
# Create .env file
cat > .env << 'EOF'
ANTHROPIC_API_KEY=your-key-here
SANDBOX_BASE_URL=https://app.textql.com
SANDBOX_API_KEY=your-key-here
CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000
EOF

# Create logs directory
mkdir -p logs
```

### 6. Start with PM2
```bash
# Start the app
pm2 start ecosystem.config.cjs

# Save PM2 config (survives reboot)
pm2 save
pm2 startup  # Follow the instructions it prints
```

### 7. Configure Nginx
```bash
# Copy nginx config
sudo cp deploy/nginx.conf /etc/nginx/sites-available/sql-agent

# Edit to set your domain/IP
sudo nano /etc/nginx/sites-available/sql-agent

# Enable site
sudo ln -s /etc/nginx/sites-available/sql-agent /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default  # Remove default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

### 8. (Optional) Setup SSL with Let's Encrypt
```bash
sudo certbot --nginx -d your-domain.com
```

## Useful Commands

```bash
# View logs
pm2 logs sql-agent

# Restart app
pm2 restart sql-agent

# Check status
pm2 status

# Update and redeploy
cd ~/app
git pull
pnpm install
pnpm run build
pm2 restart sql-agent
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API key | Yes |
| `SANDBOX_API_KEY` | TextQL Sandcastle API key | Yes |
| `SANDBOX_BASE_URL` | Sandcastle base URL (default `https://app.textql.com`) | No |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Max tokens for responses | No (default: 128000) |
| `PORT` | Server port | No (default: 3000 in production) |

## Costs

- **GCP e2-small VM**: ~$15/month
- **TextQL Sandcastles**: Pay-per-use (compute hours; see TextQL billing)
- **Anthropic API**: Pay-per-use

## Troubleshooting

**App not starting?**
```bash
pm2 logs sql-agent --lines 50
```

**WebSocket issues?**
- Check nginx config has `proxy_read_timeout 86400`
- Ensure `Upgrade` and `Connection` headers are set

**502 Bad Gateway?**
- App might not be running: `pm2 status`
- Check app logs: `pm2 logs`
