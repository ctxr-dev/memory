FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

WORKDIR /app

COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci --omit=dev

COPY mcp-server/src ./src

CMD ["sleep", "infinity"]
