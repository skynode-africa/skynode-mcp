import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import type { SkyNodeApi } from "./api.js"
import { SkyNodeError } from "./api.js"
import { formatInstanceDetail, formatInstanceList } from "./format.js"

/**
 * Catalogue d'outils du jalon 1 : lecture seule, API SkyNode uniquement.
 *
 * Aucun outil n'écrit, aucun n'ouvre de session SSH. C'est ce qui rend ce jalon
 * inoffensif : le pire résultat d'une injection de prompt dans un dépôt lu par l'agent
 * est la lecture de la liste des serveurs de son propre utilisateur.
 */

/** Rendu attendu par le protocole pour un contenu textuel. */
type ToolResult = {
  content: { type: "text"; text: string }[]
  isError?: boolean
}

const text = (value: string): ToolResult => ({
  content: [{ type: "text", text: value }],
})

const failure = (value: string): ToolResult => ({
  content: [{ type: "text", text: value }],
  isError: true,
})

/**
 * Une exception remonterait au SDK, qui la convertirait en erreur de protocole opaque :
 * l'agent perdrait le message explicatif, qui est précisément ce qui lui permet de
 * corriger le tir plutôt que de réessayer.
 */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof SkyNodeError) {
      return failure(error.message)
    }

    // Bogue ou réponse malformée : une pile Node n'aiderait ni l'agent ni son
    // utilisateur, et polluerait le contexte de la conversation.
    return failure(
      "Erreur inattendue du serveur MCP SkyNode. Relancez la commande ; si elle échoue " +
        "encore, signalez-le sur github.com/zampou-code/skynode-mcp/issues."
    )
  }
}

export function registerTools(server: McpServer, api: SkyNodeApi): void {
  server.registerTool(
    "list_servers",
    {
      title: "Lister mes serveurs SkyNode",
      description:
        "Liste les serveurs (VPS) du compte SkyNode : nom, adresse IP, état, identifiant. " +
        "À appeler en premier pour savoir sur quelle machine travailler. Lecture seule.",
      inputSchema: {},
    },
    async () => guard(async () => text(formatInstanceList(await api.listInstances())))
  )

  server.registerTool(
    "server_status",
    {
      title: "Détail d’un serveur SkyNode",
      description:
        "Détaille un serveur : état, adresses IP, système, région, utilisateur SSH, " +
        "échéance de facturation. L’identifiant s’obtient avec list_servers. Lecture seule.",
      inputSchema: {
        server_id: z
          .string()
          .describe("Identifiant du serveur, tel que rendu par list_servers"),
      },
    },
    async ({ server_id }) =>
      guard(async () => text(formatInstanceDetail(await api.getInstance(server_id))))
  )
}
