FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

COPY package.json ./
COPY server.js ./
COPY public ./public

VOLUME ["/app/data"]
EXPOSE 3000
CMD ["npm", "start"]
