FROM node:20-slim

WORKDIR /app

# Copy engine files only (no npm install needed — zero deps)
COPY .experience/ .experience/
COPY server.js .
COPY tools/ tools/

# Create store directory
RUN mkdir -p /root/.experience/store/default

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:8082/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
