FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY backend/package.json ./
RUN npm install --production

# Copy backend
COPY backend/server.js ./

# Copy frontend
COPY frontend/public ./frontend/public

# Expose port
EXPOSE 3000

# Run
CMD ["node", "server.js"]
