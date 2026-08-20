import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import type { SkyNodeApi } from "./api.js"
import { SkyNodeError } from "./api.js"
import { formatInstanceDetail, formatInstanceList } from "./format.js"
import { analyzeProject } from "./project-analyze.js"
import { ScanError, scanProject } from "./project-scan.js"
import { PROBE_SCRIPT, ProbeError, parseProbe } from "./probe.js"
import { formatProjectReport, formatServerReport } from "./report.js"
import { classify } from "./regime.js"
import type { SshRunner } from "./ssh.js"
import { explainSsh, resolveSshTarget } from "./ssh.js"

/**
 * Catalogue d'outils du jalon 2 : le jalon 1 (lecture de l'API SkyNode) rejoint ici le
 * constat local (`project-scan`, `project-analyze`) et le constat distant (`probe`,
 * `regime`) livrés depuis.
 *
 * Aucun outil n'écrit, aucun n'installe ni ne modifie quoi que ce soit — `inspect_server`
 * ouvre une session SSH, mais uniquement pour lire. C'est ce qui rend ce jalon inoffensif :
 * le pire résultat d'une injection de prompt dans un dépôt lu par l'agent, ou dans un
 * fichier trouvé sur le serveur constaté, est la lecture d'informations déjà accessibles à
 * l'utilisateur légitime de ce jeton.
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
 * corriger le tir plutôt que de réessayer. `ScanError` et `ProbeError` rejoignent ici
 * `SkyNodeError` : les trois portent déjà un message français prêt à afficher, produit
 * par le module qui les lève — `guard()` n'a qu'à le relayer tel quel.
 */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof SkyNodeError || error instanceof ScanError || error instanceof ProbeError) {
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

export function registerTools(server: McpServer, api: SkyNodeApi, ssh: SshRunner): void {
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
        /*
          Cette validation s'exécute côté SDK, avant d'entrer dans le gestionnaire —
          donc en dehors de `guard()`. Le message par défaut de Zod (« expected string,
          received undefined ») serait renvoyé tel quel à l'agent, en anglais : `error`
          le remplace par un message français qui dit quoi faire. `.describe()` reste
          nécessaire à côté : il alimente le schéma JSON annoncé au client, `error` ne
          sert qu'au message de refus.

          Le préfixe `MCP error -32602: Input validation error: …` qui entoure ce
          message reste, lui, en anglais : il vient du SDK et ne nous appartient pas.
        */
        server_id: z
          .string({
            error:
              "L’identifiant du serveur est obligatoire. Obtenez-le avec list_servers.",
          })
          .describe("Identifiant du serveur, tel que rendu par list_servers"),
      },
    },
    async ({ server_id }) =>
      guard(async () => text(formatInstanceDetail(await api.getInstance(server_id))))
  )

  server.registerTool(
    "inspect_project",
    {
      title: "Constater un projet local",
      description:
        "Constate ce que contient un projet avant de le déployer : Dockerfile ou " +
        "docker-compose déjà présents, runtime et framework détectés, port, clés " +
        "d'environnement, poids de l'arborescence. À appeler avant inspect_server. " +
        "Lecture seule : rien n'est écrit, et aucun contenu de fichier n'est renvoyé.",
      inputSchema: {
        path: z
          .string({ error: "Le chemin absolu de la racine du projet est obligatoire." })
          .describe("Chemin absolu de la racine du projet à constater"),
      },
    },
    async ({ path }) =>
      guard(async () => text(formatProjectReport(analyzeProject(await scanProject(path)))))
  )

  server.registerTool(
    "inspect_server",
    {
      title: "Constater un serveur SkyNode",
      description:
        "Constate l'état réel d'un serveur par SSH : système, ressources, Docker, reverse " +
        "proxy, ports occupés, panneau de contrôle éventuel. Conclut sur un régime et dit " +
        "si un déploiement y est possible, ou ce qu'il faut faire sinon. L'identifiant " +
        "s'obtient avec list_servers. Lecture seule : rien n'est installé ni modifié, à " +
        "l'exception d'un test d'élévation (`sudo -n true`) qui peut laisser une trace " +
        "dans les journaux du serveur si l'utilisateur n'y a pas droit.",
      inputSchema: {
        server_id: z
          .string({ error: "L’identifiant du serveur est obligatoire. Obtenez-le avec list_servers." })
          .describe("Identifiant du serveur, tel que rendu par list_servers"),
        ssh_user: z
          .string()
          .optional()
          .describe("Utilisateur SSH, si différent de celui que l’API déclare"),
      },
    },
    async ({ server_id, ssh_user }) =>
      guard(async () => {
        const instance = await api.getInstance(server_id)
        const target = resolveSshTarget(instance, ssh_user)
        const result = await ssh.run(target, PROBE_SCRIPT)

        const echec = explainSsh(result)
        if (echec) return failure(echec)

        const facts = parseProbe(result.stdout)

        return text(formatServerReport(instance, facts, classify(facts)))
      })
  )
}
