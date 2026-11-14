FROM node:24.22.2-bookworm-slim
WORKDIR /opt/companion
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
# The engine pins Playwright 1.65.0, including this matching Chromium installer.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node node_modules/playwright-core/cli.js install --with-deps chromium
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
COPY bridge.mjs serve.mjs app.mjs client.mjs process-proof.mjs proof.test.mjs lifecycle.test.mjs orphan-fixture.mjs LICENSE ./
COPY project ./project
RUN mkdir -p /opt/companion/state && chown -R node:node /opt/companion && chmod -R a+rX /ms-playwright
USER node
EXPOSE 3100
CMD ["node", "serve.mjs"]
