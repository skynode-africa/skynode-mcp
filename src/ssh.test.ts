import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
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
   * utilisateur — d'où la validation, et non un simple échappement.
   */
  it("refuse un utilisateur qui tenterait de désigner un hôte", () => {
    for (const mauvais of ["root@evil.com", "-oProxyCommand=curl x", "a b", "../root", ""]) {
      expect(() => resolveSshTarget(instance(), mauvais)).toThrow(/utilisateur/i)
    }
  })

  it("refuse un serveur qui n'est pas en fonctionnement, en disant son état", () => {
    expect(() => resolveSshTarget(instance({ status: "PROVISIONING" }))).toThrow(/livraison/)
    expect(() => resolveSshTarget(instance({ status: "SUSPENDED" }))).toThrow(/impayé/)
  })

  it("refuse un serveur sans adresse IPv4", () => {
    expect(() => resolveSshTarget(instance({ ipv4: null }))).toThrow(/adresse/i)
  })

  it("se rabat sur root quand l'API ne donne pas d'utilisateur", () => {
    expect(resolveSshTarget(instance({ defaultUser: null })).user).toBe("root")
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

  it.each(cas)("traduit « %s »", (stderr, attendu) => {
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
})

describe("systemSsh", () => {
  it("passe le script sur l'entrée standard et rend la sortie", async () => {
    const runner = systemSsh({ bin: fixture("faux-ssh.sh") })
    const result = await runner.run({ host: "192.0.2.10", user: "root" }, "emit probe.end 1\n")

    expect(result.code).toBe(0)
    expect(result.stdout).toContain("emit probe.end 1")
    expect(result.stdout).toContain("BatchMode=yes")
    // Le script ne doit apparaître nulle part dans les arguments.
    expect(result.stdout.split("\n")[0]).not.toContain("emit probe.end")
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

  it("rend un code non nul plutôt que de lever quand le binaire n'existe pas", async () => {
    const runner = systemSsh({ bin: fixture("n-existe-pas.sh") })
    const result = await runner.run({ host: "192.0.2.10", user: "root" }, "")

    expect(result.code).not.toBe(0)
    expect(explainSsh(result)).toBeTruthy()
  })
})
