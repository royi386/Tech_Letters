FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    COOKIE_SECURE=1

WORKDIR /app

COPY --chown=node:node serve.js index.html admin.html management.html ./
COPY --chown=node:node assets ./assets
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5173/api/state').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "serve.js"]