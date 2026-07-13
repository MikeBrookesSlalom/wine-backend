# Official Puppeteer image ships Chromium + all system deps preinstalled
FROM ghcr.io/puppeteer/puppeteer:23.0.0

# The base image runs as user "pptruser"; set working dir it can write to
WORKDIR /home/pptruser/app

# Install deps
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY wine-backend.mjs ./

# Puppeteer in this image uses the bundled Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "wine-backend.mjs"]
