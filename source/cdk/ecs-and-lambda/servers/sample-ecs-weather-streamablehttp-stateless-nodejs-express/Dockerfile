# Use Node.js 22 as the base image (LTS version)
FROM node:22-slim

# Set working directory
WORKDIR /app

# Install required packages
RUN apt-get update && apt-get install -y curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json .
COPY package-lock.json .
COPY tsconfig.json .

# Install dependencies
RUN npm ci

# Copy source files
COPY src/ ./src/

# Build TypeScript code
RUN npm run build

# Create a non-root user and group
RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup appuser

# Set appropriate ownership
RUN chown -R appuser:appgroup /app

# Set environment variables
ENV PORT=8080
ENV BASE_PATH=""

# Expose port for container
EXPOSE 8080

# Switch to non-root user
USER appuser

# Add simple healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080${BASE_PATH}/ || exit 1

# Run the weather application
CMD ["node", "build/index.js"]
