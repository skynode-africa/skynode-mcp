import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
    expect(s).toMatch(/<<'[A-Za-z0-9_]+'/)
  })

  /**
   * Un contenu qui porterait le délimiteur du heredoc couperait le script en deux, et la
   * suite du fichier deviendrait des commandes. C'est l'évasion à fermer ici.
   */
  it("refuse un contenu qui porte le délimiteur", () => {
    expect(() => writeFileScript("/x", "avant\nSKYNODE_EOF\naprès\n", "0600")).toThrow(/délimiteur/i)
  })

  it("crée le répertoire parent", () => {
    expect(writeFileScript("/etc/skynode/apps/x.env", "", "0600")).toContain("mkdir -p '/etc/skynode/apps'")
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

/**
 * Relecture après implémentation : trois défauts Critiques et quatre Importants remontés
 * par exécution réelle en conteneur (`debian:12-slim`, `/bin/sh` = `dash`). Chaque test
 * ci-dessous rejoue le scénario exact qui les a démontrés.
 */

describe("runRemote > marqueur de fin usurpé (I3)", () => {
  /**
   * `step.end` égaré ailleurs qu'en dernière ligne — par exemple dans un `step.detail`
   * multiligne — ne doit pas faire lire une sortie coupée comme complète : seule la
   * dernière ligne non vide fait foi.
   */
  it("refuse un marqueur de fin qui n'est pas la dernière ligne", async () => {
    const r = await runRemote(
      fakeSsh({ stdout: "step.outcome\tapplied\nstep.end\t1\nstep.detail\tsuite coupée" }),
      target, "x"
    )

    expect(r.outcome).toBe("failed")
    expect(r.detail).toMatch(/interrompu|incomplet/i)
  })
})

describe("shellQuote > octet nul (I4)", () => {
  /**
   * `dash` et `busybox ash` suppriment silencieusement un octet nul en repassant la valeur
   * par `printf '%s'` : ni erreur, ni troncature visible, juste un contenu différent de
   * celui demandé, écrit en root. Refuser vaut mieux qu'un octet perdu sans témoin.
   */
  it("refuse plutôt que de perdre un octet en silence", () => {
    expect(() => shellQuote("a\0b")).toThrow()
  })
})

describe("writeFileScript > mode (C3)", () => {
  /**
   * Démontré par exécution en conteneur : sans validation, `mode` change le mode d'un
   * autre fichier (`"0600 /etc/passwd"`) ou exécute une deuxième commande (`"0600; …"`).
   */
  it.each([
    "0600; touch /tmp/PWNED_MODE",
    "0600 /etc/passwd",
    "+x",
    "abc",
    "",
    "12345",
    "0600\ntouch /tmp/PWNED_MODE",
  ])("refuse le mode %j", (mode) => {
    expect(() => writeFileScript("/etc/skynode/apps/x.env", "A=1\n", mode)).toThrow(/mode/i)
  })

  it.each(["600", "0600", "0644", "4755", "700"])("accepte le mode légitime %j", (mode) => {
    expect(() => writeFileScript("/etc/skynode/apps/x.env", "A=1\n", mode)).not.toThrow()
  })
})

describe("writeFileScript > chemin hostile (C3)", () => {
  /**
   * Démontré par exécution en conteneur : sans `shellQuote`, `;` dans `path` exécutait une
   * deuxième commande. `mkdir -p`/`cat >` échouent probablement sur un tel nom de fichier
   * littéral une fois quoté — c'est attendu, seule l'absence d'exécution du fragment
   * injecté compte ici.
   */
  it("un chemin quoté n'exécute jamais ce qu'il porte", () => {
    const base = mkdtempSync(join(tmpdir(), "sk-c3-path-"))
    try {
      const pwned = join(base, "PWNED_PATH")
      const hostilePath = `${base}/x; touch ${pwned}`
      const script = writeFileScript(hostilePath, "contenu\n", "0600")

      try {
        execFileSync("/bin/sh", ["-c", script])
      } catch {
        // Échec attendu : le chemin littéral, une fois quoté, n'est pas forcément un
        // chemin de fichier valide. Seule l'absence d'exécution du `touch` injecté compte.
      }

      expect(existsSync(pwned)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("writeFileScript > fidélité du contenu à l'octet (I1)", () => {
  /**
   * Démontré par exécution en conteneur : `""` produisait un fichier de 1 octet (une ligne
   * vide), `"A=1\n"` produisait 5 octets (une ligne vide en trop) — le heredoc composé par
   * `join("\n")` ajoutait systématiquement un séparateur, peu importe si le contenu en
   * portait déjà un. Le contraire romprait l'idempotence : une étape qui compare un
   * condensat au contenu écrit ne rendrait jamais `unchanged`.
   */
  it.each([
    ["", 0],
    ["A=1\n", 4],
    ["A=1\nB=2\n", 8],
  ] as const)("écrit %j sur exactement %i octet(s)", (content, size) => {
    const base = mkdtempSync(join(tmpdir(), "sk-i1-"))
    try {
      const target = join(base, "x.env")
      execFileSync("/bin/sh", ["-c", writeFileScript(target, content, "0600")])

      const written = readFileSync(target)
      expect(written.length).toBe(size)
      expect(written.toString("utf8")).toBe(content)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("writeFileScript > répertoire parent sans '/' (I2)", () => {
  /**
   * `path.lastIndexOf("/")` rend `-1` quand `path` ne porte aucun `/` ; `slice(0, -1)`
   * retire alors le dernier caractère de `path` au lieu de rendre une chaîne vide, et le
   * repli `|| "/"` ne se déclenche jamais puisque le résultat n'est pas vide. Démontré :
   * `writeFileScript("Dockerfile", …)` produisait `mkdir -p Dockerfil`.
   */
  it("ne tronque pas le chemin quand il n'a pas de répertoire", () => {
    const s = writeFileScript("Dockerfile", "FROM node\n", "0644")

    expect(s).toContain("mkdir -p '.'")
    expect(s).not.toContain("mkdir -p 'Dockerfil'")
  })
})

describe("markerBlockScript > fichier sans saut de ligne final (C1)", () => {
  /**
   * Démontré par exécution en conteneur : un `Caddyfile` humain sans `\n` final produisait
   * `}# >>> skynode >>>` — la ligne humaine corrompue, et le marqueur plus jamais retrouvé
   * par un `sed` ancré en début de ligne au retrait (fichier resté à 124 o au lieu de
   * revenir à 48 o).
   */
  it("isole le marqueur, repose sans doublon, et le retrait restaure le contenu humain", () => {
    const base = mkdtempSync(join(tmpdir(), "sk-c1-"))
    try {
      const file = join(base, "Caddyfile")
      const human = "# ligne humaine\nsite.exemple.ci {\n  reverse_proxy 127.0.0.1:9000\n}"
      writeFileSync(file, human) // délibérément sans \n final

      execFileSync("/bin/sh", ["-c", markerBlockScript(file, "skynode", "import /etc/skynode/caddy/sites/*.caddy")])
      const afterFirstPose = readFileSync(file, "utf8")

      expect(afterFirstPose).not.toContain("}# >>>")
      expect(afterFirstPose.split("\n")).toContain("# >>> skynode >>>")
      expect((afterFirstPose.match(/# >>> skynode >>>/g) ?? []).length).toBe(1)

      execFileSync("/bin/sh", ["-c", markerBlockScript(file, "skynode", "import /etc/skynode/caddy/sites/*.caddy")])
      const afterSecondPose = readFileSync(file, "utf8")

      // Reposé une deuxième fois : pas de doublon, l'ancien bloc a bien été retiré avant le nouveau.
      expect((afterSecondPose.match(/# >>> skynode >>>/g) ?? []).length).toBe(1)

      execFileSync("/bin/sh", ["-c", removeMarkerBlockScript(file, "skynode")])
      const afterRemove = readFileSync(file, "utf8")

      expect(afterRemove).not.toContain("skynode")
      // Le contenu humain revient intact ; seul un saut de ligne final peut avoir été
      // ajouté (comportement POSIX correct), d'où la comparaison sans le trainling `\n`.
      expect(afterRemove.trimEnd()).toBe(human.trimEnd())
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("removeMarkerBlockScript > marqueur d'ouverture orphelin (C2)", () => {
  /**
   * Démontré par exécution en conteneur : `sed '/^a$/,/^b$/d'` sans deuxième adresse
   * trouvée supprime jusqu'à EOF. Un marqueur d'ouverture orphelin — laissé par une pose
   * interrompue en cours de route, puisque les trois `printf` de `markerBlockScript` ne
   * sont pas atomiques — ne doit donc rien faire supprimer.
   */
  it("ne supprime rien quand le marqueur de fermeture est absent", () => {
    const base = mkdtempSync(join(tmpdir(), "sk-c2-"))
    try {
      const file = join(base, "Caddyfile")
      const corrupted = "ligne 1\nligne 2\n# >>> skynode >>>\nligne 4\n"
      writeFileSync(file, corrupted)

      execFileSync("/bin/sh", ["-c", removeMarkerBlockScript(file, "skynode")])

      expect(readFileSync(file, "utf8")).toBe(corrupted)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("removeMarkerBlockScript > fichier absent (mineur)", () => {
  /** Défaire une étape ne doit pas faire apparaître un fichier qui n'existait pas avant elle. */
  it("ne crée pas un fichier qui n'existait pas", () => {
    const base = mkdtempSync(join(tmpdir(), "sk-nofile-"))
    try {
      const file = join(base, "jamais-cree.conf")
      execFileSync("/bin/sh", ["-c", removeMarkerBlockScript(file, "skynode")])

      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("runRemote > diagnostic (mineurs)", () => {
  it("marque un diagnostic tronqué plutôt que de couper en silence", async () => {
    const r = await runRemote(fakeSsh({ code: 1, stdout: "", stderr: "x".repeat(5000) }), target, "x")

    expect(r.diagnostic.startsWith("[sortie tronquée]")).toBe(true)
  })

  it("sépare stdout et stderr dans le diagnostic combiné, sans les coller", async () => {
    const r = await runRemote(
      fakeSsh({ stdout: "step.outcome\tapplied", stderr: "erreur distincte" }),
      target, "x"
    )

    expect(r.diagnostic).toContain("applied\nerreur distincte")
  })
})

describe("la métadonnée du fichier survit au remplacement", () => {
  /**
   * `mv` ne remplace pas le contenu de l'inode visé : il y met le fichier temporaire, avec
   * sa métadonnée à lui. Sans relevé préalable, un Caddyfile `caddy:caddy 640` deviendrait
   * `root:root 644` — et sous un umask permissif, un `600` deviendrait `666`, donc une
   * configuration inscriptible par tout le monde, sans que rien ne le signale.
   */
  it("relève propriétaire, groupe et mode avant de remplacer", () => {
    const s = removeMarkerBlockScript("/etc/caddy/Caddyfile", "skynode")

    expect(s).toMatch(/stat -c '%u %g %a'/)
    expect(s.indexOf("stat -c")).toBeLessThan(s.indexOf("skynode-tmp"))
  })

  it("repose les trois valeurs après le remplacement", () => {
    const s = removeMarkerBlockScript("/etc/caddy/Caddyfile", "skynode")

    expect(s).toMatch(/chown /)
    expect(s).toMatch(/chmod /)
    expect(s.indexOf("mv ")).toBeLessThan(s.indexOf("chown "))
  })

  /** Un fichier absent n'a pas de métadonnée à préserver : la repose ne doit pas s'exécuter. */
  it("ne repose rien quand il n'y avait pas de fichier", () => {
    expect(removeMarkerBlockScript("/etc/caddy/Caddyfile", "skynode")).toMatch(/if \[ -n "\$meta" \]/)
  })

  it("pose le bloc en préservant la métadonnée, puisqu'il retire d'abord", () => {
    expect(markerBlockScript("/etc/caddy/Caddyfile", "skynode", "import x")).toMatch(/stat -c '%u %g %a'/)
  })
})

describe("writeFileScript refuse un contenu qu'un heredoc ne transporte pas", () => {
  /**
   * `sh` laisse tomber l'octet nul en silence : treize octets réclamés, douze posés — sur
   * un fichier qui peut porter des secrets, et en root. Refuser vaut mieux qu'écrire à côté.
   */
  it("refuse un octet nul dans le contenu", () => {
    const contenu = "avant" + String.fromCharCode(0) + "après\n"

    expect(() => writeFileScript("/etc/skynode/apps/x.env", contenu, "0600")).toThrow(/octet nul/i)
  })

  it("accepte un contenu ordinaire, accents et CRLF compris", () => {
    expect(() => writeFileScript("/etc/skynode/apps/x.env", "A=é\r\nB=2\n", "0600")).not.toThrow()
  })
})
