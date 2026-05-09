FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

WORKDIR /app

COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci --omit=dev

COPY mcp-server/src ./src

# Make /app readable by the non-root `node` user (uid 1000) shipped with
# the official node image. We don't write to /app at runtime; node only
# needs read access to src/ and node_modules/.
RUN chown -R node:node /app

# Drop privileges. The container only runs `sleep infinity` and is
# `docker exec`-driven by the bridge — no host bind-mount permission
# issue (workspace is mounted :ro). Defense-in-depth: an exec'd command
# now runs as node, not root.
USER node

CMD ["sleep", "infinity"]
