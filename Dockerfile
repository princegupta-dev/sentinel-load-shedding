FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src/ ./src/
EXPOSE 8080
CMD ["node", "server.js"]
