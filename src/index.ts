#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { SkyNodeApi } from "./api.js"
import { readConfig } from "./config.js"
import { registerTools } from "./tools.js"

/**
 * Point d'entrée du serveur MCP SkyNode.
 *
 * **Rien ne s'écrit sur la sortie standard** : elle porte le protocole MCP, et un seul
 * `console.log` égaré corromprait le flux de messages — le client afficherait une erreur
 * d'analyse sans rapport avec sa cause. Les diagnostics vont sur la sortie d'erreur.
 */
async function main(): Promise<void> {
  const config = readConfig(process.env)
  const server = new McpServer({ name: "skynode", version: "0.1.0" })

  registerTools(server, new SkyNodeApi(config))

  await server.connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  /*
    Une configuration absente est le cas le plus fréquent au premier lancement. Le
    message de `readConfig` dit quoi faire ; l'accompagner d'une pile le noierait.
  */
  console.error(
    `[skynode-mcp] ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
})
