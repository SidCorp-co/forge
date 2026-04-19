FROM node:22-alpine AS build
RUN apk add --no-cache build-base gcc autoconf automake zlib-dev libpng-dev vips-dev python3
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache vips
WORKDIR /app

COPY --from=build /app ./

RUN npm prune --omit=dev

EXPOSE 1337
CMD ["npm", "run", "start"]
