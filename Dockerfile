FROM node:20-alpine

WORKDIR /app

# Install root (backend) dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy backend source and build
COPY backend/ backend/
RUN npm ci && npm run build:backend

# Copy server entry point and supporting files
COPY server.js ./
COPY manifest.webmanifest ./
COPY favicon.ico ./

# Copy pre-built frontend (build locally or in CI before docker build)
COPY frontend/dist/ frontend/dist/

EXPOSE 3000

CMD ["node", "server.js"]
