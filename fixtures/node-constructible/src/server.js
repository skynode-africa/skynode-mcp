// Fixture du banc : un serveur sans dépendance, pour que la construction éprouve le
// Dockerfile engendré et non la disponibilité d'un registre.
import { createServer } from "node:http"

const port = Number.parseInt(process.env.PORT ?? "3000", 10)

createServer((_requete, reponse) => {
  reponse.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
  reponse.end("boutique\n")
}).listen(port)
