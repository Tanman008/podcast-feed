FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

CMD ["npm", "run", "worker"]
