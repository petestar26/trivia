FROM node:22-alpine
WORKDIR /app
COPY deployment/dashboard-preview/index.html /app/index.html
COPY deployment/dashboard-preview/server.mjs /app/server.mjs
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
