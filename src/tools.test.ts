import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"

import type { Instance } from "./api.js"
import { SkyNodeApi, SkyNodeError } from "./api.js"
import { registerTools } from "./tools.js"

const instance: Instance = {
  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  hostname: "boutique",
  status: "RUNNING",
  ipv4: "203.0.113.10",
  ipv6: null,
  region: "EU",
  osImage: "ubuntu-24-04",
  planId: "9a1b2c3d-4e5f-6789-abcd-ef0123456789",
  cycle: "MONTHLY",
  defaultUser: "root",
  nextRenewalAt: "2026-09-13T00:00:00.000Z",
  provisionedAt: "2026-08-01T10:00:00.000Z",
  createdAt: "2026-08-01T09:00:00.000Z",
}

/**
 * Monte un serveur réel et récupère les gestionnaires enregistrés. Simuler le SDK
 * laisserait passer une signature d'enregistrement fausse — l'erreur la plus probable
 * et la seule que ce test doit attraper.
 */
function mount(api: Partial<SkyNodeApi>) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  const registered = new Map<string, (args: never) => Promise<unknown>>()

  const spy = vi
    .spyOn(server, "registerTool")
    .mockImplementation(((name: string, _config: unknown, handler: never) => {
      registered.set(name, handler as unknown as (args: never) => Promise<unknown>)
      return undefined
    }) as never)

  registerTools(server, api as SkyNodeApi)
  spy.mockRestore()

  return registered
}

describe("registerTools", () => {
  it("enregistre les deux outils du jalon", () => {
    const tools = mount({})

    expect([...tools.keys()].sort()).toEqual(["list_servers", "server_status"])
  })

  it("rend la liste mise en forme", async () => {
    const tools = mount({ listInstances: async () => [instance] })

    const result = (await tools.get("list_servers")!({} as never)) as {
      content: { text: string }[]
    }

    expect(result.content[0].text).toContain("boutique")
  })

  /**
   * Le SDK convertirait une exception en erreur de protocole opaque. L'agent doit lire
   * le message explicatif — c'est tout l'intérêt d'avoir traduit les refus.
   */
  it("rend un refus de portée comme un contenu d’erreur lisible", async () => {
    const tools = mount({
      listInstances: async () => {
        throw new SkyNodeError(403, "Ce jeton n’a pas la portée « instances:read »")
      },
    })

    const result = (await tools.get("list_servers")!({} as never)) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("instances:read")
  })

  it("passe l’identifiant à l’API pour le détail", async () => {
    const getInstance = vi.fn().mockResolvedValue(instance)
    const tools = mount({ getInstance })

    const result = (await tools.get("server_status")!({
      server_id: instance.id,
    } as never)) as { content: { text: string }[] }

    expect(getInstance).toHaveBeenCalledWith(instance.id)
    expect(result.content[0].text).toContain("en fonctionnement")
  })

  /**
   * Une erreur inattendue — bogue, réponse malformée — ne doit pas remonter en pile
   * Node au milieu de la conversation.
   */
  it("n’expose pas une erreur inattendue telle quelle", async () => {
    const tools = mount({
      listInstances: async () => {
        throw new Error("TypeError: undefined is not a function")
      },
    })

    const result = (await tools.get("list_servers")!({} as never)) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).not.toContain("undefined is not a function")
  })
})
