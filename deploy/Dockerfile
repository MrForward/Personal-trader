FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    TRADING_LAB_HOST=127.0.0.1 \
    TRADING_LAB_PORT=3000 \
    TRADING_LAB_DB_PATH=/data/trading-lab.sqlite
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/server.mjs"]
