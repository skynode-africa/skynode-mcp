import { describe, expect, it } from "vitest"

import { analyzeProject } from "./project-analyze.js"
import type { ProjectSnapshot } from "./project-scan.js"

function snapshot(partial: Partial<ProjectSnapshot>): ProjectSnapshot {
  return {
    root: "/projet",
    markers: [],
    contents: {},
    envKeys: {},
    composeServices: {},
    dockerfileHints: {},
    weight: { files: 10, bytes: 20_000, tronque: false },
    excluded: [],
    ...partial,
  }
}

const nextPackage = JSON.stringify({
  scripts: { build: "next build", start: "next start" },
  dependencies: { next: "15.1.0", "@prisma/client": "7.0.0" },
})

describe("analyzeProject", () => {
  it("reconnaît Next.js en sortie standalone", () => {
    const facts = analyzeProject(
      snapshot({
        markers: ["package.json", "next.config.ts", "pnpm-lock.yaml", ".nvmrc"],
        contents: {
          "package.json": nextPackage,
          "next.config.ts": 'export default { output: "standalone" }',
          ".nvmrc": "22.11.0\n",
        },
      })
    )

    expect(facts.runtime.family).toBe("node")
    expect(facts.runtime.version).toBe("22")
    expect(facts.runtime.packageManager).toBe("pnpm")
    expect(facts.framework).toBe("next")
    expect(facts.output.mode).toBe("standalone")
    expect(facts.output.directory).toBe(".next/standalone")
    expect(facts.port).toEqual({ value: 3000, source: "port par défaut de Next.js" })
  })

  /**
   * La règle la plus importante de la spec (§5.3) : le dépôt qui déclare son
   * architecture l'emporte sur toute déduction. Le développeur a exprimé un choix.
   */
  it("relève un Dockerfile déclaré et en tire le port", () => {
    const facts = analyzeProject(
      snapshot({
        markers: ["Dockerfile", "package.json"],
        contents: { "package.json": nextPackage },
        dockerfileHints: { Dockerfile: { expose: [8080], from: ["node:22-alpine"] } },
      })
    )

    expect(facts.declared.dockerfiles).toEqual(["Dockerfile"])
    expect(facts.port).toEqual({ value: 8080, source: "EXPOSE dans Dockerfile" })
  })

  it("relève un compose déclaré et ses services", () => {
    const facts = analyzeProject(
      snapshot({
        markers: ["docker-compose.yml"],
        composeServices: {
          "docker-compose.yml": [
            { name: "web", ports: ["8080:3000"] },
            { name: "db", ports: [] },
          ],
        },
      })
    )

    expect(facts.declared.composeFiles).toEqual(["docker-compose.yml"])
    expect(facts.declared.services.map((s) => s.name)).toEqual(["web", "db"])
  })

  it("déduit le gestionnaire du fichier de verrouillage, pas d'un champ déclaratif", () => {
    const facts = analyzeProject(
      snapshot({ markers: ["package.json", "yarn.lock"], contents: { "package.json": "{}" } })
    )

    expect(facts.runtime.packageManager).toBe("yarn")
  })

  it("reconnaît un projet Python à FastAPI", () => {
    const facts = analyzeProject(
      snapshot({
        markers: ["requirements.txt", ".python-version"],
        contents: {
          "requirements.txt": "fastapi==0.115.0\nuvicorn[standard]==0.32.0\npsycopg2==2.9\n",
          ".python-version": "3.12\n",
        },
      })
    )

    expect(facts.runtime.family).toBe("python")
    expect(facts.runtime.version).toBe("3.12")
    expect(facts.framework).toBe("fastapi")
    expect(facts.port).toEqual({ value: 8000, source: "port par défaut d'Uvicorn" })
    expect(facts.data.engines).toContain("postgres")
  })

  it("reconnaît un site statique", () => {
    const facts = analyzeProject(snapshot({ markers: ["index.html"] }))

    expect(facts.runtime.family).toBe("static")
    expect(facts.output.mode).toBe("static")
  })

  /**
   * Le refus est un résultat, pas un échec (spec §4.4). Il doit nommer ce qui a été
   * cherché, sans quoi le développeur ne peut pas corriger.
   */
  it("conclut « inconnu » sans supposer, et dit ce qui a été cherché", () => {
    const facts = analyzeProject(snapshot({ markers: [".gitignore"] }))

    expect(facts.runtime.family).toBe("inconnu")
    expect(facts.runtime.evidence).toEqual([])
    expect(facts.warnings.join(" ")).toMatch(/Dockerfile/)
  })

  it("signale un monorepo sans choisir le paquet", () => {
    const facts = analyzeProject(
      snapshot({
        markers: ["package.json", "pnpm-workspace.yaml", "apps/site/package.json", "apps/api/package.json"],
        contents: { "package.json": "{}", "pnpm-workspace.yaml": "packages:\n  - apps/*\n" },
      })
    )

    expect(facts.monorepo.detected).toBe(true)
    expect(facts.monorepo.packages).toEqual(["apps/api", "apps/site"])
    expect(facts.warnings.join(" ")).toMatch(/quel paquet/i)
  })

  it("avertit d'un .env porteur de valeurs réelles présent dans l'arborescence", () => {
    const facts = analyzeProject(
      snapshot({
        markers: ["package.json", ".gitignore"],
        contents: { "package.json": "{}", ".gitignore": "dist\n" },
        envKeys: { ".env.production": ["DATABASE_URL"] },
      })
    )

    expect(facts.env.hasLocalSecrets).toBe(true)
    expect(facts.warnings.join(" ")).toMatch(/\.env\.production/)
    expect(facts.warnings.join(" ")).toMatch(/gitignore/i)
  })

  it("avertit d'une arborescence lourde", () => {
    const facts = analyzeProject(
      snapshot({ markers: ["package.json"], contents: { "package.json": "{}" },
                 weight: { files: 4000, bytes: 900_000_000, tronque: false } })
    )

    expect(facts.warnings.join(" ")).toMatch(/858 Mio|Mio|Gio/)
  })

  it("ne lève jamais sur un package.json illisible", () => {
    const facts = analyzeProject(
      snapshot({ markers: ["package.json"], contents: { "package.json": "{ cassé" } })
    )

    expect(facts.runtime.family).toBe("node")
    expect(facts.warnings.join(" ")).toMatch(/package\.json/)
  })

  /**
   * Relecture, constat 1 : une recherche de sous-chaîne sur le .gitignore brut se
   * laissait tromper par un commentaire qui *mentionne* ".env" sans le couvrir — la
   * conclusion « couvert » était rendue avec la même confiance qu'une vraie.
   */
  it("n'est pas trompé par un .gitignore qui ne mentionne .env que dans un commentaire", () => {
    const facts = analyzeProject(
      snapshot({
        markers: ["package.json", ".gitignore"],
        contents: {
          "package.json": "{}",
          ".gitignore": "# voir .env.example pour le modèle\nnode_modules\n",
        },
        envKeys: { ".env.production": ["DATABASE_URL"] },
      })
    )

    expect(facts.env.hasLocalSecrets).toBe(true)
    expect(facts.warnings.join(" ")).toMatch(/\.env\.production/)
  })

  /**
   * Relecture, constat 2 : un projet à sortie statique (script build sans start) n'a
   * aucun port applicatif, quel que soit le framework qui l'a produit — lui prêter un
   * défaut serait présenter une supposition comme un fait.
   */
  it("ne prête aucun port par défaut à une sortie statique", () => {
    const facts = analyzeProject(
      snapshot({
        markers: ["package.json"],
        contents: {
          "package.json": JSON.stringify({
            scripts: { build: "vite build" },
            dependencies: { vite: "5.4.0" },
          }),
        },
      })
    )

    expect(facts.output.mode).toBe("static")
    expect(facts.port.value).toBeNull()
    expect(facts.port.source).toMatch(/statique/i)
  })
})
