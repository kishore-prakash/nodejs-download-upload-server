FROM node:22-alpine

WORKDIR /app

ADD . .

EXPOSE 3000

CMD node server.js
