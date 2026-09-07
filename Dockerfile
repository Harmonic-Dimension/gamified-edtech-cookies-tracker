# Pinned to the Playwright image that matches the Playwright version in
# package.json. Changing one without the other breaks reproducibility.
ARG PLAYWRIGHT_VERSION=1.63.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}

# x11vnc + noVNC let you watch and drive a *visible* browser that runs inside
# this container, which is how interactive audit sessions work in Docker.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify fluxbox ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY fixtures ./fixtures
COPY tests ./tests
COPY docs ./docs
COPY data/trackers ./data/trackers
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV AUDIT_IN_DOCKER=1 \
    AUDIT_DATA_DIR=/app/data \
    AUDIT_RESULTS_DIR=/app/data/audits \
    AUDIT_TRACKER_DIR=/app/data/trackers \
    DISPLAY=:99 \
    PORT=3000 \
    NODE_ENV=production

EXPOSE 3000 6080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "serve"]
