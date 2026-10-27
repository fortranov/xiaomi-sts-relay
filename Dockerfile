FROM node:22-alpine
WORKDIR /app
COPY package.json relay.mjs server.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
