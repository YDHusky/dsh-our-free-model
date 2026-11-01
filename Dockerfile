FROM oven/bun:1.3.6 AS bun

FROM node:24-slim

ENV NODE_ENV=production \
    OFM_DATA_DIR=/data \
    OFM_PORT=8080 \
    OUR_FREE_MODEL_BUN=/usr/local/bin/bun

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --chown=node:node . .

RUN mkdir -p /data \
    && chown node:node /data

USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
  CMD ["node", "packages/proxy/healthcheck.mjs"]

CMD ["node", "packages/proxy/cli.mjs"]
