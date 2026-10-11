FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# Data lives in a volume mounted at /app/data (see README). The host attaches it.
EXPOSE 3000
CMD ["npm", "start"]
