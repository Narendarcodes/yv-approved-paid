# ---- Frontend build stage ----
FROM node:24-alpine AS frontend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
# Vite inlines import.meta.env.VITE_* at build time. Empty = same-origin /api/v1
# (the default; put the API behind the same reverse proxy at /api/v1).
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

# ---- Runtime: serve with a minimal static server ----
FROM node:24-alpine AS frontend-runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g serve@14.2.6
COPY --from=frontend-build /app/dist ./dist
# serve the static build; in production behind a reverse proxy that also
# handles /api/v1 → backend:3000
EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
