# Hosted GoHighLevel MCP server.
#
# No dependencies to install, so this is a copy and a CMD. Alpine + a non-root user + a
# read-only-friendly layout; the only writable path needed is /data.
FROM node:22-alpine

# Tini reaps zombies and forwards SIGTERM, so the graceful shutdown in server.js actually runs.
RUN apk add --no-cache tini

WORKDIR /app

# Both halves of the connector: the hosted server, and the shared tool layer it reuses.
COPY mcp-server/package.json ./mcp-server/package.json
COPY mcp-server/src ./mcp-server/src
COPY remote/package.json ./remote/package.json
COPY remote/server.js ./remote/server.js
COPY remote/src ./remote/src

# Credentials and OAuth state live here. Mount a volume: losing it disconnects everyone.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8787 \
    HOST=0.0.0.0

USER node
EXPOSE 8787

# Fails the container when the server stops answering, so a platform can restart it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "remote/server.js"]
