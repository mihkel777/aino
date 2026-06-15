# Aino booking backend. Small image; serves on $PORT (set by the platform).
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# App source.
COPY . .

# The platform injects $PORT; server.js falls back to 8080 locally.
CMD ["npm", "start"]
