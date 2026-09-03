# Dockerfile fourni par le développeur : SkyNode ne le remplace jamais (invariant n°2), et
# c'est son EXPOSE qui fait connaître le port d'écoute au constat du projet.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN npm run build
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
