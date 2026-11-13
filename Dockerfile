# Small production image. Data lives on a mounted volume at /var/data.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/var/data PORT=8080
COPY server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /var/data && chown -R node:node /var/data /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
