FROM node:22-slim

WORKDIR /app

# Copy engine files only (no npm install needed — zero deps)
COPY .experience/ .experience/
COPY api/ api/
COPY lib/ lib/
COPY server.js .
COPY tools/ tools/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The server itself runs as "node" (see docker-entrypoint.sh); the entrypoint
# starts as root only to fix ownership of volumes written by older root images.
ENV HOME=/home/node
# Inside the container the port is only reachable through the published
# mapping (127.0.0.1-only in docker-compose.yml), so listen on all interfaces.
ENV EXP_SERVER_HOST=0.0.0.0
RUN mkdir -p /home/node/.experience/store/default && chown -R node:node /home/node/.experience

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:8082/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
