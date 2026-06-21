FROM node:20-bullseye

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8000
CMD ["npm", "start"]
