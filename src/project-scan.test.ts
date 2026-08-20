import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { scanProject } from "./project-scan.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => resolve(here, "..", "fixtures", name)

describe("scanProject", () => {
  it("relève les marqueurs d'un projet Next sans Dockerfile", async () => {
    const snapshot = await scanProject(fixture("next-sans-dockerfile"))

    expect(snapshot.markers).toContain("package.json")
    expect(snapshot.markers).toContain("next.config.ts")
    expect(snapshot.markers).toContain("pnpm-lock.yaml")
    expect(snapshot.markers).toContain(".nvmrc")
    expect(snapshot.markers).not.toContain("src/app/page.tsx")
  })

  it("lit le contenu des fichiers sûrs", async () => {
    const snapshot = await scanProject(fixture("next-sans-dockerfile"))

    expect(snapshot.contents["package.json"]).toContain("\"next\"")
    expect(snapshot.contents[".nvmrc"]?.trim()).toBe("22.11.0")
  })

  /**
   * L'invariant central de cette tâche. Un secret qui entre dans l'instantané en
   * ressortira un jour — par un message d'erreur, un journal, ou une réponse d'outil
   * rendue telle quelle à l'agent.
   */
  it("ne conserve que les noms de clés d'un .env, jamais les valeurs", async () => {
    const snapshot = await scanProject(fixture("next-sans-dockerfile"))

    expect(snapshot.envKeys[".env.production"]).toEqual([
      "DATABASE_URL",
      "STRIPE_KEY",
      "PUBLIC_URL",
    ])

    const dump = JSON.stringify(snapshot)
    expect(dump).not.toContain("VALEUR_FICTIVE_A")
    expect(dump).not.toContain("VALEUR_FICTIVE_B")
    expect(snapshot.contents[".env.production"]).toBeUndefined()
  })

  it("ne retient d'un compose que les services et les ports publiés", async () => {
    const snapshot = await scanProject(fixture("compose"))

    expect(snapshot.composeServices["docker-compose.yml"]).toEqual([
      { name: "web", ports: ["8080:3000"] },
      { name: "db", ports: [] },
    ])

    expect(JSON.stringify(snapshot)).not.toContain("ne-doit-pas-ressortir")
    expect(snapshot.contents["docker-compose.yml"]).toBeUndefined()
  })

  it("ne retient d'un Dockerfile que les ports exposés et les images de base", async () => {
    const snapshot = await scanProject(fixture("compose"))

    expect(snapshot.dockerfileHints["Dockerfile"]).toEqual({
      expose: [3000],
      from: ["node:22-alpine"],
    })
  })

  /**
   * Le poids sert à prévenir un transfert de plusieurs gigaoctets au jalon 3. Compter
   * node_modules le rendrait toujours alarmant et donc ignoré.
   */
  it("exclut node_modules du poids et le signale", async () => {
    const snapshot = await scanProject(fixture("next-sans-dockerfile"))

    expect(snapshot.weight.bytes).toBeLessThan(50_000)
    expect(snapshot.excluded).toContain("node_modules")
  })

  it("rend un instantané vide plutôt qu'une erreur sur un répertoire sans marqueur", async () => {
    const snapshot = await scanProject(fixture("vide"))

    expect(snapshot.markers).toEqual([])
    expect(snapshot.weight.files).toBe(1)
  })

  it("refuse un chemin qui n'est pas un répertoire", async () => {
    await expect(scanProject(fixture("next-sans-dockerfile/package.json"))).rejects.toThrow(
      /répertoire/
    )
  })

  it("refuse un chemin inexistant en le nommant", async () => {
    await expect(scanProject(fixture("n-existe-pas"))).rejects.toThrow(/n-existe-pas/)
  })
})
