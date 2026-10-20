FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./

# Built-in non-root "node" user (uid/gid 1000)
USER node
EXPOSE 8080

# Exec form so node is PID 1 and receives SIGTERM directly
CMD ["node", "server.js"]
