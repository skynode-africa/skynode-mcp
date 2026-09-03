import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { generateDockerignore } from "./dockerfile.js"
import {
  buildTransferCommand,
  exclusionsDepuisDockerignore,
  exigeRacineLocale,
  exigeRepertoireDeTravail,
  transferProject,
} from "./transfer.js"

const ici = dirname(fileURLToPath(import.meta.url))
const fixture = (nom: string): string => resolve(ici, "..", "fixtures", nom)

const aNettoyer: string[] = []

/**
 * Un répertoire de travail jetable **portant le segment `skynode`** : le script de réception
 * y fait un `rm -rf`, et `exigeRepertoireDeTravail` refuse tout chemin qui ne porte pas ce
 * segment. Le test doit donc emprunter le même chemin que la production, pas le contourner.
 */
function travailJetable(): string {
  const base = mkdtempSync(join(tmpdir(), "sk-transfert-"))
  aNettoyer.push(base)

  return join(base, "skynode", "travail")
}

afterAll(() => {
  for (const chemin of aNettoyer) rmSync(chemin, { recursive: true, force: true })
})

describe("buildTransferCommand", () => {
  /** L'invariant repris du jalon 3a : aucune valeur d'environnement ne quitte la machine. */
  it("exclut ce que le .dockerignore exclut, .env imbriqués compris", () => {
    const c = buildTransferCommand("/projet", "/tmp/skynode-build-x/skynode/x", null)

    expect(c.args.join(" ")).toMatch(/--exclude/)
    expect(c.args.join(" ")).toMatch(/\.env/)
    expect(c.args.join(" ")).toMatch(/node_modules/)
  })

  it("préserve le répertoire de sortie d'un site statique", () => {
    const c = buildTransferCommand("/projet", "/tmp/skynode/x", "dist")

    expect(c.args.join(" ")).not.toMatch(/--exclude[= ]dist(\s|$)/)
  })

  /** Le même répertoire reste exclu quand rien ne demande de le préserver. */
  it("exclut dist par défaut", () => {
    const c = buildTransferCommand("/projet", "/tmp/skynode/x", null)

    expect(c.args).toContain("--exclude=dist")
  })

  /** Le chemin vient du développeur : il ne doit jamais devenir une option de tar. */
  it.each(["../etc", "/etc", "--checkpoint-action=exec=sh", "-C /etc", "a b", ""])(
    "refuse une racine hostile : %s",
    (racine) => {
      expect(() => buildTransferCommand(racine, "/tmp/skynode/x", null)).toThrow()
    }
  )

  it("n'invoque jamais un shell", () => {
    expect(buildTransferCommand("/projet", "/tmp/skynode/x", null)).not.toHaveProperty("shell")
  })

  /**
   * Un argument par élément, et le chemin du développeur en argument de `--directory` : c'est
   * la seule forme qui empêche `tar` de relire une valeur comme une option.
   */
  it("passe la racine en argument de --directory, jamais collée à autre chose", () => {
    const c = buildTransferCommand("/home/dev/boutique", "/tmp/skynode/x", null)

    expect(c.command).toBe("tar")
    expect(c.args).toContain("--directory")
    expect(c.args[c.args.indexOf("--directory") + 1]).toBe("/home/dev/boutique")
  })

  /** `--` clôt les options : plus rien ensuite ne peut être lu comme un drapeau. */
  it("clôt les options avant de nommer ce qu'il archive", () => {
    const c = buildTransferCommand("/projet", "/tmp/skynode/x", null)

    expect(c.args[c.args.length - 2]).toBe("--")
    expect(c.args[c.args.length - 1]).toBe(".")
  })

  /**
   * `Dockerfile` et `.dockerignore` n'ont rien à faire dans une image, mais tout à faire à
   * côté d'elle : les exclure du transfert rendrait invisible le `Dockerfile` du client, et
   * `build.generate_dockerfile` poserait le sien par-dessus une intention qu'il n'aurait
   * même pas pu constater.
   */
  it("transfère le Dockerfile et le .dockerignore du client", () => {
    const c = buildTransferCommand("/projet", "/tmp/skynode/x", null)

    expect(c.args).not.toContain("--exclude=Dockerfile")
    expect(c.args).not.toContain("--exclude=.dockerignore")
  })

  /** Une racine dont le chemin porte une espace est ordinaire ; elle ne traverse aucun shell. */
  it("accepte une racine dont un segment porte une espace", () => {
    const c = buildTransferCommand("/Users/dev/Mes projets/boutique", "/tmp/skynode/x", null)

    expect(c.args).toContain("/Users/dev/Mes projets/boutique")
  })

  it("refuse un répertoire de travail qui ne porte pas le segment skynode", () => {
    expect(() => buildTransferCommand("/projet", "/opt/travail/boutique", null)).toThrow(/skynode/)
  })

  it("refuse un preserveDir mal formé", () => {
    expect(() => buildTransferCommand("/projet", "/tmp/skynode/x", "../etc")).toThrow()
  })
})

describe("exigeRacineLocale", () => {
  /**
   * Une racine sous `/etc` enverrait clés et mots de passe de la machine du développeur dans
   * un contexte de construction, donc dans une image livrée au client.
   */
  it.each(["/etc", "/etc/skynode", "/proc/self", "/root", "/sys/kernel", "/dev"])(
    "refuse l'arborescence système %s",
    (chemin) => {
      expect(() => exigeRacineLocale(chemin)).toThrow(/système/)
    }
  )

  /** Un répertoire de rassemblement emporterait tout ce qu'il contient. */
  it.each(["/home", "/Users", "/var", "/usr", "/opt", "/tmp"])("refuse le répertoire %s", (chemin) => {
    expect(() => exigeRacineLocale(chemin)).toThrow(/rassemblement/)
  })

  /** Mais leur contenu est l'endroit le plus ordinaire d'un projet. */
  it.each(["/home/dev/boutique", "/Users/dev/boutique", "/var/projets/boutique", "/opt/boutique"])(
    "accepte %s",
    (chemin) => {
      expect(exigeRacineLocale(chemin)).toBe(chemin)
    }
  )

  it("refuse la racine du système de fichiers", () => {
    expect(() => exigeRacineLocale("/")).toThrow()
  })

  it("refuse un segment « .. », même au milieu d'un chemin absolu", () => {
    expect(() => exigeRacineLocale("/home/dev/../../etc")).toThrow()
  })

  it("refuse un saut de ligne dans le chemin", () => {
    expect(() => exigeRacineLocale("/home/dev/bou\ntique")).toThrow()
  })

  it("tolère une barre oblique finale et la normalise", () => {
    expect(exigeRacineLocale("/home/dev/boutique/")).toBe("/home/dev/boutique")
  })
})

describe("exigeRepertoireDeTravail", () => {
  /**
   * Le script de réception fait un `rm -rf` sur ce chemin : ce contrôle est le seul qui
   * sépare « vider le répertoire de travail » de « effacer une arborescence du client ».
   */
  it.each(["/opt/travail/boutique", "/srv/apps/boutique", "/var/lib/docker"])(
    "refuse %s, qui ne porte pas notre segment",
    (chemin) => {
      expect(() => exigeRepertoireDeTravail(chemin)).toThrow(/skynode/)
    }
  )

  it("refuse un chemin d'un seul segment, fût-il le nôtre", () => {
    expect(() => exigeRepertoireDeTravail("/skynode")).toThrow()
  })

  it("refuse une espace, contrairement à la racine locale", () => {
    expect(() => exigeRepertoireDeTravail("/opt/skynode/mon travail")).toThrow()
  })

  it("accepte le répertoire de travail du produit", () => {
    expect(exigeRepertoireDeTravail("/opt/skynode/work/boutique")).toBe("/opt/skynode/work/boutique")
  })
})

describe("exclusionsDepuisDockerignore", () => {
  /** Le même vocabulaire pour ce qui entre dans l'image et pour ce qui traverse le réseau. */
  it("reprend les motifs du .dockerignore du produit", () => {
    const motifs = exclusionsDepuisDockerignore(generateDockerignore(null))

    expect(motifs).toContain("node_modules")
    expect(motifs).toContain(".env")
    expect(motifs).toContain(".env.*")
    expect(motifs).toContain(".npmrc")
    expect(motifs).toContain(".git")
  })

  /** Les exclusions de `tar` ne sont pas ancrées : le préfixe de récursion est redondant. */
  it("réduit un motif récursif au motif nu, sans le dupliquer", () => {
    const motifs = exclusionsDepuisDockerignore("**/.env\n.env\n**/.npmrc\n")

    expect(motifs).toEqual([".env", ".npmrc"])
  })

  /** Une négation ne retire qu'une exclusion littéralement identique. */
  it("annule une exclusion que la négation reprend mot pour mot", () => {
    expect(exclusionsDepuisDockerignore("dist\nbuild\n!dist\n")).toEqual(["build"])
  })

  /**
   * `.env.example` reste exclu du transfert alors qu'il entre dans l'image : c'est `.env.*`,
   * un motif, qui l'exclut, et la négation ne porte pas sur lui. L'écart va dans le seul sens
   * acceptable — le transfert peut être plus strict que l'image, jamais plus laxiste.
   */
  it("n'annule pas une exclusion par motif, seulement une exclusion littérale", () => {
    expect(exclusionsDepuisDockerignore(".env.*\n!.env.example\n")).toEqual([".env.*"])
  })

  it("ignore les commentaires et les lignes vides", () => {
    expect(exclusionsDepuisDockerignore("# rien\n\n  \nnode_modules\n")).toEqual(["node_modules"])
  })

  it("retire les deux fichiers dont la construction distante dépend", () => {
    const motifs = exclusionsDepuisDockerignore(generateDockerignore(null))

    expect(motifs).not.toContain("Dockerfile")
    expect(motifs).not.toContain(".dockerignore")
  })

  /** Un motif portant une espace se scinderait en deux arguments chez un appelant futur. */
  it("refuse un motif qui ne tiendrait pas dans un seul argument", () => {
    expect(() => exclusionsDepuisDockerignore("mon dossier\n")).toThrow(/argument/)
  })
})

describe("le script de réception", () => {
  const c = buildTransferCommand("/projet", "/opt/skynode/work/boutique", null)

  /**
   * Sans cela, les fichiers d'un déploiement précédent survivraient dans le contexte de
   * construction, entreraient dans le condensat et dans l'image : on livrerait un mélange de
   * deux versions.
   */
  it("vide le répertoire de travail avant d'extraire", () => {
    expect(c.remoteScript).toMatch(/rm -rf -- '\/opt\/skynode\/work\/boutique'/)
    expect(c.remoteScript.indexOf("rm -rf")).toBeLessThan(c.remoteScript.indexOf("tar --extract"))
  })

  /**
   * `tar` en root restaure par défaut le propriétaire inscrit dans l'archive, c'est-à-dire
   * l'UID du développeur sur **sa** machine : le répertoire de travail se retrouverait
   * possédé par un compte qui n'existe pas sur le serveur.
   */
  it("n'applique jamais le propriétaire inscrit dans l'archive", () => {
    expect(c.remoteScript).toContain("--no-same-owner")
  })

  /** Une session coupée au milieu ne doit pas se lire comme un transfert abouti. */
  it("rend un marqueur de fin", () => {
    expect(c.remoteScript).toContain("transfer.end")
  })

  /**
   * `bsdtar` détecte la compression tout seul et pardonnerait un désaccord entre les deux
   * côtés ; le `tar` GNU du serveur, non. Le défaut ne se verrait donc qu'en production.
   */
  it("comprime et décomprime avec la même option", () => {
    expect(c.args).toContain("--gzip")
    expect(c.remoteScript).toContain("--gzip")
  })

  it("met le chemin en sécurité au lieu de le coller nu", () => {
    expect(c.remoteScript).not.toMatch(/rm -rf -- \/opt/)
  })
})

/**
 * Le transfert éprouvé pour de vrai : `tar` local, script de réception joué par un `sh`, et
 * l'arborescence constatée sur le disque. Une doublure qui rendrait un code de sortie ne
 * dirait rien de ce qui traverse effectivement le réseau — or c'est exactement l'invariant.
 */
describe("transferProject", () => {
  const cible = { host: "192.0.2.10", user: "root" }
  const fauxSsh = fixture("faux-ssh-transfert.sh")

  it("dépose l'arborescence sans les dépendances ni les fichiers d'environnement", async () => {
    const travail = travailJetable()

    const r = await transferProject(cible, fixture("next-sans-dockerfile"), travail, null, {
      sshBin: fauxSsh,
    })

    expect(r.ok).toBe(true)
    expect(existsSync(join(travail, "package.json"))).toBe(true)
    expect(existsSync(join(travail, "src", "app", "page.tsx"))).toBe(true)
    expect(existsSync(join(travail, "node_modules"))).toBe(false)
    expect(existsSync(join(travail, ".env.production"))).toBe(false)
    expect(r.fichiers).toBeGreaterThan(0)
  })

  /**
   * L'invariant de non-fuite, constaté sur le contenu : la fixture porte deux valeurs
   * fictives dans son `.env.production`, et aucune ne doit se retrouver du côté serveur.
   */
  it("ne laisse passer aucune valeur d'un .env", async () => {
    const travail = travailJetable()
    await transferProject(cible, fixture("next-sans-dockerfile"), travail, null, { sshBin: fauxSsh })

    const trouve: string[] = []
    const parcours = (repertoire: string): void => {
      for (const entree of readdirSync(repertoire, { withFileTypes: true })) {
        const chemin = join(repertoire, entree.name)
        if (entree.isDirectory()) {
          parcours(chemin)
          continue
        }
        const contenu = readFileSync(chemin, "utf8")
        if (contenu.includes("VALEUR_FICTIVE_A") || contenu.includes("VALEUR_FICTIVE_B")) {
          trouve.push(chemin)
        }
      }
    }
    parcours(travail)

    expect(trouve).toEqual([])
  })

  /**
   * Un `.env` de sous-dossier échappait aux motifs naïfs : il est exclu au même titre que
   * celui de la racine, parce que les exclusions de `tar` ne sont pas ancrées.
   */
  it("exclut aussi les .env imbriqués", async () => {
    const source = mkdtempSync(join(tmpdir(), "sk-transfert-src-"))
    aNettoyer.push(source)
    mkdirSync(join(source, "apps", "api"), { recursive: true })
    writeFileSync(join(source, "apps", "api", ".env"), "SECRET=VALEUR_FICTIVE_C\n")
    writeFileSync(join(source, "apps", "api", "index.js"), "console.log(1)\n")

    const travail = travailJetable()
    await transferProject(cible, source, travail, null, { sshBin: fauxSsh })

    expect(existsSync(join(travail, "apps", "api", "index.js"))).toBe(true)
    expect(existsSync(join(travail, "apps", "api", ".env"))).toBe(false)
  })

  /** Le répertoire de sortie d'un site statique doit, lui, arriver. */
  it("transfère le répertoire préservé", async () => {
    const source = mkdtempSync(join(tmpdir(), "sk-transfert-static-"))
    aNettoyer.push(source)
    mkdirSync(join(source, "dist"), { recursive: true })
    writeFileSync(join(source, "dist", "index.html"), "<!doctype html>\n")

    const travail = travailJetable()
    await transferProject(cible, source, travail, "dist", { sshBin: fauxSsh })

    expect(existsSync(join(travail, "dist", "index.html"))).toBe(true)
  })

  /** Le répertoire de travail est vidé : un fichier d'un passage précédent ne survit pas. */
  it("ne laisse rien du passage précédent", async () => {
    const travail = travailJetable()
    mkdirSync(travail, { recursive: true })
    writeFileSync(join(travail, "ancien.txt"), "version précédente\n")

    await transferProject(cible, fixture("next-sans-dockerfile"), travail, null, { sshBin: fauxSsh })

    expect(existsSync(join(travail, "ancien.txt"))).toBe(false)
    expect(existsSync(join(travail, "package.json"))).toBe(true)
  })

  it("refuse une racine hostile avant de lancer quoi que ce soit", async () => {
    await expect(transferProject(cible, "/etc", travailJetable(), null, { sshBin: fauxSsh })).rejects.toThrow()
  })

  it("dit en français qu'un binaire manque, sans laisser de processus derrière", async () => {
    const r = await transferProject(cible, fixture("next-sans-dockerfile"), travailJetable(), null, {
      sshBin: fixture("binaire-qui-nexiste-pas"),
    })

    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/introuvable/)
  })

  it("dit en français qu'un tar manque", async () => {
    const r = await transferProject(cible, fixture("next-sans-dockerfile"), travailJetable(), null, {
      tarBin: fixture("binaire-qui-nexiste-pas"),
      sshBin: fauxSsh,
    })

    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/introuvable/)
  })

  /**
   * Sans marqueur de fin, l'archive est arrivée tronquée ou la session a coupé : le
   * répertoire de travail porte une arborescence partielle, qu'une construction prendrait
   * pour le projet entier.
   */
  it("refuse une réception sans marqueur de fin", async () => {
    const r = await transferProject(cible, fixture("next-sans-dockerfile"), travailJetable(), null, {
      sshBin: fixture("faux-ssh.sh"),
    })

    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/incomplète|interrompu/i)
  })
})
