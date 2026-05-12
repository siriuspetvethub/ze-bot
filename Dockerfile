# Build da imagem do Zé Bot
FROM node:20-alpine

# Timezone Brasil (Alpine é UTC por padrão — sem isso os crons ficam 3h errados)
RUN apk add --no-cache tzdata
ENV TZ=America/Sao_Paulo

# Diretório de trabalho
WORKDIR /app

# Instalar dependências primeiro (cache de layer)
COPY package*.json ./
RUN npm ci --only=production

# Copiar código fonte
COPY server.js ./
COPY src/ ./src/

# Porta exposta
EXPOSE 3010

# Healthcheck para o EasyPanel monitorar
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3010/health || exit 1

CMD ["node", "server.js"]
