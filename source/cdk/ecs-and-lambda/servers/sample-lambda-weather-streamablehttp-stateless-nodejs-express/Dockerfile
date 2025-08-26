FROM public.ecr.aws/docker/library/node:22-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR "/var/task"

# Set environment variables
ENV PORT=8080

# Expose port for container
EXPOSE 8080

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

CMD ["node", "build/index.js"]