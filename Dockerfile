# One container serves the web app and the API, connected to a public testnet deployment.
#
#   docker build -t trustpool .
#   docker run -p 3000:3000 -v trustpool-data:/var/data \
#     -e RPC_URL=... -e KEEPER_PRIVATE_KEY=... -e EVIDENCE_ENCRYPTION_KEY=... trustpool
#
# See docs/deployment.md for the full list of settings.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/link-chainlink-deps.js scripts/
RUN npm ci
COPY . .
# Compiles the contracts, builds the web app into dist/frontend, checks no demo keys shipped, type-checks.
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/dist/frontend \
    DEPLOYMENT_FILE=/app/deployments/sepolia.json \
    EVIDENCE_DIR=/var/data/evidence \
    ACCOUNTS_DIR=/var/data/accounts \
    KEEPER_INTERVAL_MS=60000
# The backend runs from TypeScript with tsx, so the full dependency tree comes along.
COPY --from=build /app /app
RUN mkdir -p /var/data && chown -R node:node /var/data
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# A hosting provider's persistent disk (Render's included) is mounted over /var/data owned by root,
# which hides the chown above. So the container starts as root, hands /var/data to the node user,
# and then runs the backend as node.
CMD ["sh", "-c", "chown -R node:node /var/data 2>/dev/null || true; exec setpriv --reuid=node --regid=node --init-groups node_modules/.bin/tsx backend/src/server.ts"]
