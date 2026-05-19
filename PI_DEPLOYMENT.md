# Immich Pi Deployment With OneDrive Originals

This setup is for:

- Originals stored in OneDrive
- Immich running on a Raspberry Pi
- Mobile app access from anywhere
- Public share URLs that work for anyone with the link

## What You Need

- Raspberry Pi running 64-bit Raspberry Pi OS
- Docker and Docker Compose on the Pi
- External SSD/USB storage strongly recommended
- A public URL, for example `https://photos.adityamer.dev`
- A Microsoft/Azure app registration for OneDrive
- A custom Immich server image built from this branch

## Important Architecture

The Pi still runs Immich, Postgres, Redis, thumbnails, previews, and the web/API server.

Original photos/videos are uploaded by the mobile app to Immich first, then Immich uploads them to OneDrive. After OneDrive upload succeeds, Immich removes the local original from the Pi. Thumbnails/previews/cache stay local for fast browsing.

## Build The Custom Server Image

Build on your main computer, not on the Pi 3B.

```bash
docker buildx create --use

docker buildx build \
  --platform linux/arm64 \
  -t ghcr.io/YOUR_GITHUB_USER/immich-server:onedrive-pi \
  -f server/Dockerfile \
  --push .
```

Replace `YOUR_GITHUB_USER`.

Only the Immich server image needs to be custom. The machine-learning image can stay the normal Immich image.

## Prepare The Pi

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER
```

Log out and back in.

Create storage folders:

```bash
sudo mkdir -p /mnt/immich/library /mnt/immich/postgres
sudo chown -R $USER:$USER /mnt/immich
```

Do not put Postgres on the SD card if you can avoid it.

## Create Compose Files

```bash
mkdir -p ~/immich
cd ~/immich
```

Create `docker-compose.yml`:

```yaml
name: immich

services:
  immich-server:
    container_name: immich_server
    image: ghcr.io/YOUR_GITHUB_USER/immich-server:onedrive-pi
    volumes:
      - ${UPLOAD_LOCATION}:/data
      - /etc/localtime:/etc/localtime:ro
    env_file:
      - .env
    ports:
      - "2283:2283"
    depends_on:
      - redis
      - database
    restart: always

  immich-machine-learning:
    container_name: immich_machine_learning
    image: ghcr.io/immich-app/immich-machine-learning:v2
    volumes:
      - model-cache:/cache
    env_file:
      - .env
    restart: always

  redis:
    container_name: immich_redis
    image: docker.io/valkey/valkey:9
    restart: always

  database:
    container_name: immich_postgres
    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_USER: ${DB_USERNAME}
      POSTGRES_DB: ${DB_DATABASE_NAME}
      POSTGRES_INITDB_ARGS: "--data-checksums"
    volumes:
      - ${DB_DATA_LOCATION}:/var/lib/postgresql/data
    shm_size: 128mb
    restart: always

volumes:
  model-cache:
```

## Create `.env`

Create `~/immich/.env`:

```env
UPLOAD_LOCATION=/mnt/immich/library
DB_DATA_LOCATION=/mnt/immich/postgres

TZ=Asia/Kolkata

DB_PASSWORD=make_this_long_and_random
DB_USERNAME=postgres
DB_DATABASE_NAME=immich

IMMICH_PUBLIC_LOGIN_PAGE_URI=https://photos.adityamer.dev

IMMICH_ONEDRIVE_CLIENT_ID=your-azure-app-client-id
IMMICH_ONEDRIVE_TENANT=common

IMMICH_LOW_RESOURCE_MODE=true
IMMICH_ML_SCHEDULE_START=02:00
IMMICH_ML_SCHEDULE_END=06:00
IMMICH_ML_ONLY_WHEN_IDLE=true
IMMICH_ML_DEFER_DELAY_MINUTES=15
```

Use the same public URL everywhere:

- `.env`: `IMMICH_PUBLIC_LOGIN_PAGE_URI=https://photos.adityamer.dev`
- Phone app server URL: `https://photos.adityamer.dev`
- Azure redirect URI: `https://photos.adityamer.dev/api/cloud-storage/callback/onedrive`

## Azure OneDrive App

Create an app registration in Azure.

Set redirect URI:

```text
https://photos.adityamer.dev/api/cloud-storage/callback/onedrive
```

Add Microsoft Graph delegated permissions:

- `Files.ReadWrite.All`
- `offline_access`

Use the Application/client ID:

```env
IMMICH_ONEDRIVE_CLIENT_ID=...
```

No client secret is needed for this flow.

## Start Immich

```bash
cd ~/immich
docker compose up -d
docker compose logs -f immich-server
```

Local test:

```text
http://PI_LOCAL_IP:2283
```

## Public Access

Use Cloudflare Tunnel with `photos.adityamer.dev`.

This gives you:

- Public share links
- Mobile app access from anywhere
- No router port forwarding
- Automatic HTTPS through Cloudflare

Set up the tunnel:

```bash
sudo apt install cloudflared
cloudflared tunnel login
cloudflared tunnel create immich
cloudflared tunnel route dns immich photos.adityamer.dev
```

Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: immich
credentials-file: /home/YOUR_PI_USER/.cloudflared/TUNNEL_ID.json

ingress:
  - hostname: photos.adityamer.dev
    service: http://localhost:2283
  - service: http_status:404
```

Run it as a service:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

## Final Checklist

- Immich opens at your public URL
- Azure redirect URI matches the public URL exactly
- `.env` has `IMMICH_PUBLIC_LOGIN_PAGE_URI`
- `.env` has `IMMICH_ONEDRIVE_CLIENT_ID`
- Cloud Storage page connects to OneDrive
- Mobile app uses the public URL
- Test mobile auto backup
- Test a shared link in a private/incognito browser
