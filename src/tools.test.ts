import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"

import type { Instance } from "./api.js"
import { SkyNodeApi, SkyNodeError } from "./api.js"
import type { SshResult, SshRunner } from "./ssh.js"
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

/** La plus petite sortie de sonde qui traverse `parseProbe` sans être rejetée. */
const PROBE_OK = [
  "probe.version\t1",
  "host.os_id\tubuntu",
  "host.os_version\t24.04",
  "access.elevate\troot",
  "docker.present\tnon",
  "skynode.present\tnon",
  "probe.end\t1",
].join("\n")

/** Rend une sortie de sonde valide, ou l'échec demandé. */
function fakeSsh(result?: Partial<SshResult>): SshRunner {
  return { run: async () => ({ code: 0, stdout: PROBE_OK, stderr: "", ...result }) }
}

/**
 * Monte un serveur réel et récupère les gestionnaires enregistrés. Simuler le SDK
 * laisserait passer une signature d'enregistrement fausse — l'erreur la plus probable
 * et la seule que ce test doit attraper.
 */
function mount(api: Partial<SkyNodeApi>, ssh: SshRunner = fakeSsh()) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  const registered = new Map<string, (args: never) => Promise<unknown>>()

  const spy = vi
    .spyOn(server, "registerTool")
    .mockImplementation(((name: string, _config: unknown, handler: never) => {
      registered.set(name, handler as unknown as (args: never) => Promise<unknown>)
      return undefined
    }) as never)

  registerTools(server, api as SkyNodeApi, ssh)
  spy.mockRestore()

  return registered
}

/**
 * Relie un serveur réel à un client réel via `InMemoryTransport`. Seul ce chemin exerce
 * la validation Zod du SDK, qui s'exécute avant le gestionnaire et donc hors de portée
 * de `mount()`.
 */
async function withClient<T>(
  api: Partial<SkyNodeApi>,
  ssh: SshRunner,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerTools(server, api as SkyNodeApi, ssh)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" })

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

describe("registerTools", () => {
  it("enregistre les quatre outils du jalon 2", () => {
    const tools = mount({})

    expect([...tools.keys()].sort()).toEqual([
      "inspect_project",
      "inspect_server",
      "list_servers",
      "server_status",
    ])
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

  it("constate un serveur de bout en bout", async () => {
    const tools = mount({ getInstance: vi.fn().mockResolvedValue(instance) })
    const out = await tools.get("inspect_server")!({ server_id: instance.id } as never)
    expect(JSON.stringify(out)).toMatch(/vierge/i)
  })

  /**
   * L'agent doit apprendre du refus, pas le contourner. Un `isError` sans texte utile le
   * ferait réessayer à l'identique.
   */
  it("rend l'échec SSH traduit, sans pile", async () => {
    const tools = mount(
      { getInstance: vi.fn().mockResolvedValue(instance) },
      fakeSsh({ code: 255, stdout: "", stderr: "Permission denied (publickey)." })
    )
    const out = (await tools.get("inspect_server")!({ server_id: instance.id } as never)) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(out.isError).toBe(true)
    expect(out.content[0]?.text).toMatch(/clé/i)
    expect(out.content[0]?.text).not.toMatch(/at Object\.|node:internal/)
  })

  it("n'ouvre aucune session SSH sur un serveur non démarré", async () => {
    const run = vi.fn()
    const tools = mount(
      { getInstance: vi.fn().mockResolvedValue({ ...instance, status: "PROVISIONING" }) },
      { run }
    )
    await tools.get("inspect_server")!({ server_id: instance.id } as never)
    expect(run).not.toHaveBeenCalled()
  })

  /**
   * L'invariant de la spec §8.1, vérifié au seul endroit où il peut être rompu : le
   * schéma publié ne doit exposer aucun champ d'hôte, sans quoi un agent pourrait l'y
   * glisser.
   */
  it("n'expose aucun paramètre d'hôte au client MCP", async () => {
    await withClient({}, fakeSsh(), async (client) => {
      const { tools } = await client.listTools()
      const inspect = tools.find((t) => t.name === "inspect_server")

      expect(Object.keys(inspect!.inputSchema.properties ?? {}).sort()).toEqual([
        "server_id",
        "ssh_user",
      ])
      expect(inspect!.inputSchema.required).toEqual(["server_id"])
    })
  })

  /**
   * Le brief décrit ce test avec `.rejects.toThrow` : ce n'est pas ce que rend ce SDK.
   * `CallToolRequestSchema` (mcp.js) attrape tout `McpError` — y compris celui que lève
   * `validateToolInput` sur un argument manquant — et le convertit en `CallToolResult`
   * avec `isError: true` ; la promesse se résout, elle ne rejette pas. C'est exactement
   * le motif déjà établi par « refuse en français un server_id absent » juste en dessous,
   * et le principe que la tâche énonce elle-même pour `inspect_server` : un refus est un
   * contenu textuel, jamais une exception. Assertion corrigée en conséquence — voir le
   * rapport de tâche pour le détail.
   */
  it("refuse en français un chemin de projet absent, via le vrai chemin d'appel du SDK", async () => {
    await withClient({}, fakeSsh(), async (client) => {
      const result = (await client.callTool({
        name: "inspect_project",
        arguments: {},
      })) as {
        isError?: boolean
        content: { text: string }[]
      }

      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toMatch(/chemin absolu/i)
    })
  })

  /**
   * `mount()` court-circuite `registerTool` : la validation Zod du SDK s'exécute avant
   * d'atteindre le gestionnaire, donc aucun des tests ci-dessus ne l'exerce. Seul un
   * aller-retour complet via un vrai transport le peut. Ce test le fait : serveur et
   * client réels, reliés par `InMemoryTransport`, un appel `server_status` sans
   * `server_id`.
   *
   * Ce que ce test prouve : le texte lisible par l'agent contient un message français
   * qui dit quoi faire, et plus le message générique de Zod (« expected string,
   * received undefined »). Ce qu'il ne prouve pas : que la réponse est *intégralement*
   * en français — le préfixe `MCP error -32602: Input validation error: …` reste du
   * SDK et reste en anglais, assumé (voir le commentaire au-dessus du schéma dans
   * `tools.ts`).
   */
  it("refuse en français un server_id absent, via le vrai chemin d’appel du SDK", async () => {
    await withClient({ getInstance: vi.fn() }, fakeSsh(), async (client) => {
      const result = (await client.callTool({
        name: "server_status",
        arguments: {},
      })) as {
        isError?: boolean
        content: { text: string }[]
      }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("obligatoire")
      expect(result.content[0].text).toContain("list_servers")
      expect(result.content[0].text).not.toContain("expected string")
    })
  })
})
