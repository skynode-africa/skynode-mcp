// Fixture du banc bout en bout : un serveur sans dépendance, pour que la chaîne complète
// s'éprouve sans dépendre d'un registre distant.
import { createServer } from "node:http"

const port = Number.parseInt(process.env.PORT ?? "3000", 10)

createServer((_requete, reponse) => {
  reponse.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
  reponse.end("boutique v1\n")
}).listen(port)
