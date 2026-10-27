FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package.json relay.mjs server.mjs ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD curl --fail --silent http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
