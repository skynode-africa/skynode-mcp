import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"

import { buildSshArgs, explainSsh, resolveSshTarget, systemSsh } from "./ssh.js"
import type { Instance } from "./api.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (n: string) => resolve(here, "..", "fixtures", n)

function instance(partial: Partial<Instance> = {}): Instance {
  return {
    id: "i-3f2a", hostname: "boutique", status: "RUNNING",
    ipv4: "192.0.2.10", ipv6: null, region: "EU", osImage: "ubuntu-24.04",
    planId: "vps-s", cycle: "MONTHLY", defaultUser: "root",
    nextRenewalAt: null, provisionedAt: null, createdAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  }
}

describe("resolveSshTarget", () => {
  it("prend l'IPv4 et l'utilisateur rendus par l'API", () => {
    expect(resolveSshTarget(instance())).toEqual({ host: "192.0.2.10", user: "root" })
  })

  it("accepte un utilisateur explicite valide", () => {
    expect(resolveSshTarget(instance(), "skynode").user).toBe("skynode")
  })

  /**
   * L'invariant de la spec §8.1 : il n'existe aucun paramètre d'hôte. Un agent qui a lu
   * « ssh root@evil.com » dans un README ne peut que tenter de le glisser dans le champ
   * utilisateur — d'où la validation, et non un simple échappement. `it.each` plutôt
   * qu'une boucle `for` : un cas qui échoue ne doit pas masquer les suivants.
   */
  it.each(["root@evil.com", "-oProxyCommand=curl x", "a b", "../root", ""])(
    "refuse « %s », qui tenterait de désigner un hôte",
    (mauvais) => {
      expect(() => resolveSshTarget(instance(), mauvais)).toThrow(/utilisateur/i)
    }
  )

  it("dit les règles du nom d'utilisateur et borne un nom trop long dans le message", () => {
    expect(() => resolveSshTarget(instance(), "1root")).toThrow(/32/)

    const long = "a".repeat(200)
    let messageDeLErreur = ""

    try {
      resolveSshTarget(instance(), long)
    } catch (error) {
      messageDeLErreur = error instanceof Error ? error.message : String(error)
    }

    expect(messageDeLErreur).not.toContain(long)
    expect(messageDeLErreur.length).toBeLessThan(long.length)
  })

  it("refuse un serveur qui n'est pas en fonctionnement, en disant son état", () => {
    expect(() => resolveSshTarget(instance({ status: "PROVISIONING" }))).toThrow(/livraison/)
    expect(() => resolveSshTarget(instance({ status: "SUSPENDED" }))).toThrow(/impayé/)
  })

  /**
   * SSH répond bien en mode secours, mais c'est le système de secours qui tourne alors,
   * pas le disque du client : un refus explicite vaut mieux qu'un constat qui semble
   * valide et décrit la mauvaise machine.
   */
  it("refuse un serveur en mode secours, dont la sonde constaterait le mauvais disque", () => {
    expect(() => resolveSshTarget(instance({ status: "RESCUE" }))).toThrow(/secours/)
  })

  it("donne un état lisible même quand l'API rend un statut vide", () => {
    expect(() => resolveSshTarget(instance({ status: "" }))).toThrow(/inconnu/i)
  })

  it("refuse un serveur sans adresse IPv4", () => {
    expect(() => resolveSshTarget(instance({ ipv4: null }))).toThrow(/adresse/i)
  })

  /**
   * Bien formée mais bouchon : une IPv4 syntaxiquement valide peut désigner la machine
   * du développeur lui-même. Un bug de provisioning qui laisserait passer une valeur par
   * défaut ne doit pas ouvrir de session locale et y rejouer la sonde.
   */
  it.each(["0.0.0.0", "127.0.0.1", "169.254.169.254", "01.02.03.04"])(
    "écarte %s même si la forme est valide",
    (bouchon) => {
      expect(() => resolveSshTarget(instance({ ipv4: bouchon }))).toThrow(/adresse/i)
    }
  )

  it("refuse une adresse dont la forme n'est pas une chaîne, malgré la conversion implicite d'une regex", () => {
    // Simule une réponse API malformée : `RegExp#test` convertirait un tableau à un seul
    // élément en la chaîne qu'il contient et laisserait passer la forme.
    expect(() =>
      resolveSshTarget(instance({ ipv4: ["192.0.2.10"] as unknown as string }))
    ).toThrow(/adresse/i)
  })

  it("se rabat sur root quand l'API ne donne pas d'utilisateur", () => {
    expect(resolveSshTarget(instance({ defaultUser: null })).user).toBe("root")
  })

  it("se rabat sur root quand l'API rend une chaîne vide plutôt que null", () => {
    expect(resolveSshTarget(instance({ defaultUser: "" })).user).toBe("root")
  })
})

describe("buildSshArgs", () => {
  const args = buildSshArgs({ host: "192.0.2.10", user: "skynode" })

  /**
   * Sans BatchMode, ssh demande une phrase de passe sur un terminal qui n'existe pas :
   * le serveur MCP reste bloqué jusqu'au bout du temps imparti, sans rien émettre, et
   * l'agent attend sans pouvoir dire pourquoi.
   */
  it("interdit toute invite interactive", () => {
    expect(args).toContain("BatchMode=yes")
  })

  /**
   * `accept-new` enregistre la clé d'un serveur inconnu — le cas d'un VPS neuf — mais
   * refuse toujours une clé *changée*, qui signale une réinstallation ou une
   * interception. `no` refuserait le premier cas, qui est le nôtre.
   */
  it("accepte un hôte neuf mais pas une clé changée", () => {
    expect(args).toContain("StrictHostKeyChecking=accept-new")
    expect(args).not.toContain("StrictHostKeyChecking=no")
  })

  /** `-l user host` plutôt que `user@host` : un « @ » dans le nom ne peut rien désigner. */
  it("sépare l'utilisateur de l'hôte", () => {
    expect(args).toContain("-l")
    expect(args[args.indexOf("-l") + 1]).toBe("skynode")
    expect(args).toContain("192.0.2.10")
    expect(args.join(" ")).not.toContain("skynode@")
  })

  it("demande un sh distant lisant son entrée standard", () => {
    expect(args.slice(-2)).toEqual(["/bin/sh", "-s"])
  })

  /**
   * L'option la plus défendue du cahier des charges : sans elle, ssh alloue un
   * pseudo-terminal qui traduit chaque \n en \r\n, et l'analyseur de la sonde (tâche 3)
   * lit un constat corrompu dès la première ligne coupée par un \r isolé.
   */
  it("interdit l'allocation d'un pseudo-terminal", () => {
    expect(args).toContain("-T")
  })

  it("borne le temps de poignée de main et détecte une machine qui ne répond plus", () => {
    expect(args).toContain("ConnectTimeout=10")
    expect(args).toContain("ServerAliveInterval=5")
    expect(args).toContain("ServerAliveCountMax=3")
    expect(args).toContain("LogLevel=ERROR")
  })

  it.each(["ProxyCommand", "ProxyJump", "-i", "UserKnownHostsFile", "PubkeyAuthentication=no"])(
    "n'ouvre pas l'option %s",
    (dangereux) => {
      expect(args.join(" ")).not.toContain(dangereux)
    }
  )
})

describe("explainSsh", () => {
  const cas: [string, RegExp][] = [
    ["Permission denied (publickey).", /clé/i],
    ["Host key verification failed.", /clé du serveur a changé/i],
    ["@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", /clé du serveur a changé/i],
    ["ssh: connect to host 192.0.2.10 port 22: Connection refused", /refusée/i],
    ["ssh: connect to host 192.0.2.10 port 22: Connection timed out", /pare-feu|délai/i],
    ["ssh: Could not resolve hostname", /résoudre/i],
    ["Received disconnect from 192.0.2.10: Too many authentication failures", /trop de clés/i],
  ]

  it.each(cas)("traduit « %s » (code 255)", (stderr, attendu) => {
    expect(explainSsh({ code: 255, stdout: "", stderr })).toMatch(attendu)
  })

  it("dit comment installer ssh quand le binaire manque", () => {
    expect(explainSsh({ code: 127, stdout: "", stderr: "ssh: command not found" })).toMatch(
      /OpenSSH|WSL/
    )
  })

  it("ne traduit rien quand la commande a réussi", () => {
    expect(explainSsh({ code: 0, stdout: "probe.version\t1", stderr: "" })).toBeNull()
  })

  it("rend un message générique portant le code et la sortie d'erreur", () => {
    const message = explainSsh({ code: 3, stdout: "", stderr: "quelque chose d'inédit" })
    expect(message).toMatch(/quelque chose d'inédit/)
    expect(message).toMatch(/3/)
  })

  /**
   * I1 : ssh réserve le code 255 à ses propres échecs. Un autre code est celui de la
   * commande distante (le script envoyé sur stdin) — le traduire comme un problème
   * d'authentification enverrait déboguer les clés pour une permission Unix distante.
   */
  it("attribue un échec à la commande distante quand le code n'est pas 255, pas aux clés", () => {
    const message = explainSsh({
      code: 1,
      stdout: "",
      stderr: "cat: /etc/skynode/state.json: Permission denied",
    })
    expect(message).toMatch(/commande/i)
    expect(message).not.toMatch(/clé/i)
  })

  it("ne diagnostique pas l'absence du client local pour un échec de commande distante à 127", () => {
    const message = explainSsh({
      code: 127,
      stdout: "",
      stderr: "bash: line 1: /bin/sh: No such file or directory",
    })
    expect(message).not.toMatch(/OpenSSH|WSL/)
    expect(message).toMatch(/commande/i)
  })

  /**
   * I2 : une sortie d'erreur de plusieurs milliers de lignes ne doit pas se retrouver
   * verbatim dans le contexte de l'agent — c'est le même vecteur que le contenu de
   * fichier qu'`inspect_project` refuse déjà de renvoyer, alimenté cette fois par la
   * machine distante plutôt que par un dépôt.
   */
  it("tronque une sortie d'erreur trop longue et le signale", () => {
    const longStderr = Array.from({ length: 4000 }, (_, i) => `ligne ${i}`).join("\n")
    const message = explainSsh({ code: 3, stdout: "", stderr: longStderr })

    expect(message).not.toBeNull()
    expect(message!.length).toBeLessThan(1000)
    expect(message).toMatch(/tronqu/i)
  })

  it("masque les chemins qui ressemblent à une clé SSH du développeur", () => {
    const message = explainSsh({
      code: 255,
      stdout: "",
      stderr: 'Load key "/Users/dev/.ssh/id_ed25519": bad permissions',
    })

    expect(message).not.toContain("/Users/dev/.ssh/id_ed25519")
    expect(message).not.toContain("id_ed25519")
  })

  it("ne laisse pas de deux-points orphelins quand le serveur ne renvoie aucun message", () => {
    const message = explainSsh({ code: 3, stdout: "", stderr: "" })
    expect(message).not.toMatch(/:\s*$/)
    expect(message).toMatch(/3/)
  })
})

describe("systemSsh", () => {
  it("passe le script sur l'entrée standard et rend la sortie", async () => {
    const runner = systemSsh({ bin: fixture("faux-ssh.sh") })
    const result = await runner.run({ host: "192.0.2.10", user: "root" }, "emit probe.end 1\n")

    expect(result.code).toBe(0)
    expect(result.stdout).toContain("emit probe.end 1")
    expect(result.stdout).toContain("BatchMode=yes")

    // Le script ne doit apparaître nulle part dans les arguments : la première ligne
    // porte les arguments reçus par le faux client, pas le contenu de stdin. Vérifier
    // qu'elle contient bien les arguments (et pas seulement qu'elle ignore le script)
    // ferme le passage où une sortie vide validerait la même assertion sans rien prouver.
    const [firstLine] = result.stdout.split("\n")
    expect(firstLine).toMatch(/^ARGS /)
    expect(firstLine).not.toContain("emit probe.end")
  })

  /**
   * I3 : un `Buffer` lu par blocs peut couper une séquence UTF-8 multi-octets pile à la
   * frontière. `faux-ssh.sh` renvoie l'entrée telle quelle ; une charge assez grande pour
   * forcer plusieurs blocs de lecture fait apparaître la coupure si elle n'est pas gérée.
   */
  it("ne corrompt pas un caractère multi-octets coupé à la frontière d'un bloc lu", async () => {
    const runner = systemSsh({ bin: fixture("faux-ssh.sh") })
    const payload = "€".repeat(200_000)
    const result = await runner.run({ host: "192.0.2.10", user: "root" }, payload)

    const [, echoed] = result.stdout.split("\n")
    expect(echoed).toBe(payload)
  })

  /**
   * Sans délai, une machine qui accepte la connexion puis ne répond plus laisserait
   * l'agent attendre indéfiniment. `ConnectTimeout` de ssh ne couvre que la poignée de
   * main, pas l'exécution.
   */
  it("interrompt une session qui ne rend pas la main", async () => {
    const runner = systemSsh({ bin: fixture("ssh-lent.sh"), timeoutMs: 300 })
    const result = await runner.run({ host: "192.0.2.10", user: "root" }, "")

    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/délai/i)
  })

  /**
   * Le délai dépassé ne doit pas se contenter de rendre la main à l'agent : le processus
   * doit être réellement mort, sans quoi un `ssh` orphelin par appel finirait par
   * saturer la machine du développeur. `ssh-lent.sh` consigne son propre PID avant de
   * s'y remplacer par `exec sleep 30`, pour qu'il n'y ait pas de processus intermédiaire
   * susceptible de survivre au `SIGKILL` reçu par celui qu'on vient de tuer.
   */
  it("tue réellement le processus, pas seulement le rendre orphelin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skynode-ssh-"))
    const pidFile = join(dir, "pid")
    const previous = process.env.SSH_LENT_PIDFILE
    process.env.SSH_LENT_PIDFILE = pidFile

    try {
      const runner = systemSsh({ bin: fixture("ssh-lent.sh"), timeoutMs: 300 })
      await runner.run({ host: "192.0.2.10", user: "root" }, "")
    } finally {
      if (previous === undefined) delete process.env.SSH_LENT_PIDFILE
      else process.env.SSH_LENT_PIDFILE = previous
    }

    const pid = Number(readFileSync(pidFile, "utf8").trim())
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it("rend un code non nul plutôt que de lever quand le binaire n'existe pas", async () => {
    const runner = systemSsh({ bin: fixture("n-existe-pas.sh") })
    const result = await runner.run({ host: "192.0.2.10", user: "root" }, "")

    expect(result.code).not.toBe(0)
    expect(explainSsh(result)).toBeTruthy()
  })
})
