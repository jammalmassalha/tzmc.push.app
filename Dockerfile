FROM node:20-alpine

WORKDIR /app

# Install root dependencies (includes devDependencies needed for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy backend source and build
COPY backend/ backend/
RUN npm run build:backend

# Remove devDependencies after build
RUN npm prune --omit=dev

# Copy server entry point and supporting files
COPY server.js ./
COPY manifest.webmanifest ./
COPY favicon.ico ./

# Copy pre-built frontend (build locally or in CI before docker build)
COPY frontend/dist/ frontend/dist/

EXPOSE 3000

CMD ["node", "server.js"]
