# ---- build client ----
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ---- build server + final image ----
FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./server/public

RUN mkdir -p /app/data
VOLUME /app/data

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
EXPOSE 3001

CMD ["node", "server/src/index.js"]
