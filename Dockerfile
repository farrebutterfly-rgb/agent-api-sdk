# Deployment-ready image: API server, built web UI, Python validator. Prepared, not deployed.
# Build: make docker-build    Run: see README "Deployment-ready package".
FROM node:22.20.0-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build && mkdir -p /data && chown node:node /data

# tsx stays installed: the server runs from TypeScript source, as in local development.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data EXTRACTION_MODE=fixture
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "--import", "tsx", "server/main.ts"]
