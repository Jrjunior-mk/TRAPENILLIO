FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
# The rewrite target is read at build time by Next.js
ARG API_ORIGIN=http://backend:8000
ENV API_ORIGIN=$API_ORIGIN
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
