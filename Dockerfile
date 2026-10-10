# Imagem simples para Render, Railway, Fly.io ou qualquer VPS com Docker
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
