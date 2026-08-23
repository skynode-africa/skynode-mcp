import { execFileSync } from "node:child_process"

import { describe, expect, it, vi } from "vitest"

import { markerBlockScript, removeMarkerBlockScript, runRemote, shellQuote, writeFileScript } from "./remote.js"
import type { SshResult, SshRunner } from "./ssh.js"

const target = { host: "192.0.2.10", user: "root" }
const fakeSsh = (r: Partial<SshResult>): SshRunner => ({
  run: async () => ({ code: 0, stdout: "", stderr: "", ...r }),
})

describe("runRemote", () => {
  it("lit le résultat d'un script qui a agi", async () => {
    const r = await runRemote(
      fakeSsh({ stdout: "step.outcome\tapplied\nstep.detail\tDocker installé\nstep.end\t1" }),
      target, "x"
    )

    expect(r.outcome).toBe("applied")
    expect(r.detail).toBe("Docker installé")
  })

  it("lit un script qui n'avait rien à faire", async () => {
    const r = await runRemote(
      fakeSsh({ stdout: "step.outcome\tunchanged\nstep.detail\tDocker était déjà présent\nstep.end\t1" }),
      target, "x"
    )

    expect(r.outcome).toBe("unchanged")
  })

  /**
   * Sans marqueur de fin, la sortie est tronquée. Interpréter un résultat partiel ferait
   * croire une étape appliquée alors qu'elle s'est arrêtée au milieu — et l'exécuteur
   * enchaînerait sur la suivante.
   */
  it("refuse une sortie tronquée", async () => {
    const r = await runRemote(fakeSsh({ stdout: "step.outcome\tapplied" }), target, "x")

    expect(r.outcome).toBe("failed")
    expect(r.detail).toMatch(/interrompu|incomplet/i)
  })

  it("rend failed sur un code de sortie non nul, avec le diagnostic", async () => {
    const r = await runRemote(
      fakeSsh({ code: 1, stdout: "", stderr: "E: Unable to locate package docker-ce" }),
      target, "x"
    )

    expect(r.outcome).toBe("failed")
    expect(r.diagnostic).toContain("docker-ce")
  })

  /** Un échec SSH n'est pas un échec d'étape : le message doit désigner la connexion. */
  it("distingue un échec de connexion d'un échec de script", async () => {
    const r = await runRemote(
      fakeSsh({ code: 255, stderr: "Permission denied (publickey)." }), target, "x"
    )

    expect(r.outcome).toBe("failed")
    expect(r.detail).toMatch(/clé/i)
  })

  /**
   * Le diagnostic vient de la machine du client : il peut porter un chemin de clé, ou
   * faire des milliers de lignes. Même règle qu'`explainSsh` au jalon 2.
   */
  it("borne le diagnostic et masque les chemins de clés", async () => {
    const r = await runRemote(
      fakeSsh({ code: 1, stderr: "x\n".repeat(4000) + 'Load key "/home/u/.ssh/id_ed25519": bad' }),
      target, "x"
    )

    expect(r.diagnostic.length).toBeLessThan(1200)
    expect(r.diagnostic).not.toContain("/home/u/.ssh/id_ed25519")
  })

  it("passe le script sur l'entrée standard, jamais en argument", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "step.outcome\tapplied\nstep.detail\tx\nstep.end\t1", stderr: "" }))
    await runRemote({ run }, target, "echo bonjour")

    expect(run).toHaveBeenCalledWith(target, "echo bonjour")
  })
})

describe("shellQuote", () => {
  it.each([
    ["simple", "'simple'"],
    ["avec espace", "'avec espace'"],
    ["l'apostrophe", "'l'\\''apostrophe'"],
    ["$(id)", "'$(id)'"],
    ["`id`", "'`id`'"],
    ["a;rm -rf /", "'a;rm -rf /'"],
    ["a\nb", "'a\nb'"],
  ])("met %s en sécurité", (entree, attendu) => {
    expect(shellQuote(entree)).toBe(attendu)
  })

  /**
   * Éprouvé par exécution réelle en tâche 1 : ce que `shellQuote` produit doit être rendu
   * intact par un `sh`, quelle que soit l'entrée.
   */
  it.each([
    "simple", "avec espace", "l'apostrophe", "$(id)", "`id`", "a;rm -rf /", "a|b", "a&b",
    "a\nb", "a\tb", "$HOME", "${X}", "\\", '"', "*", "?", "[a]", "!", "#", "~",
    "é à ù", "日本語", "a'b'c",
  ])("survit à un aller-retour par sh sur des entrées hostiles : %j", (valeur) => {
    const sortie = execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(valeur)}`], { encoding: "utf8" })
    expect(sortie).toBe(valeur)
  })
})

describe("writeFileScript", () => {
  it("écrit par heredoc avec le mode demandé", () => {
    const s = writeFileScript("/etc/skynode/apps/boutique.env", "A=1\n", "0600")

    expect(s).toContain("/etc/skynode/apps/boutique.env")
    expect(s).toContain("chmod 0600")
    expect(s).toMatch(/<<'[A-Z_]+'/)
  })

  /**
   * Un contenu qui porterait le délimiteur du heredoc couperait le script en deux, et la
   * suite du fichier deviendrait des commandes. C'est l'évasion à fermer ici.
   */
  it("refuse un contenu qui porte le délimiteur", () => {
    expect(() => writeFileScript("/x", "avant\nSKYNODE_EOF\naprès\n", "0600")).toThrow(/délimiteur/i)
  })

  it("crée le répertoire parent", () => {
    expect(writeFileScript("/etc/skynode/apps/x.env", "", "0600")).toContain("mkdir -p /etc/skynode/apps")
  })
})

describe("markerBlockScript", () => {
  it("pose un bloc encadré par ses marqueurs", () => {
    const s = markerBlockScript("/etc/caddy/Caddyfile", "skynode", "import /etc/skynode/caddy/sites/*.caddy")

    expect(s).toContain("# >>> skynode >>>")
    expect(s).toContain("# <<< skynode <<<")
  })

  /**
   * L'invariant de la spec §6.4. Le script doit retirer l'ancien bloc et rajouter le
   * nouveau, sans jamais réécrire le fichier entier — ce qui effacerait ce qu'un humain y
   * a mis.
   */
  it("ne réécrit jamais le fichier entier", () => {
    const s = markerBlockScript("/etc/caddy/Caddyfile", "skynode", "x")

    expect(s).not.toMatch(/>\s*\/etc\/caddy\/Caddyfile\s*$/m)
    expect(s).toContain("sed")
  })

  it("retire exactement son bloc", () => {
    const s = removeMarkerBlockScript("/etc/caddy/Caddyfile", "skynode")

    expect(s).toContain("# >>> skynode >>>")
    expect(s).toContain("# <<< skynode <<<")
  })
})
