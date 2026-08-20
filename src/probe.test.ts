import { describe, expect, it } from "vitest"

import { PROBE_SCRIPT, parseProbe } from "./probe.js"

/** Construit une sortie de sonde à partir de couples, avec en-tête et fin. */
function raw(...lines: [string, string][]): string {
  return [
    "probe.version\t1",
    ...lines.map(([k, v]) => `${k}\t${v}`),
    "probe.end\t1",
  ].join("\n")
}

describe("PROBE_SCRIPT", () => {
  /**
   * `/bin/sh` est `dash` sur Debian et Ubuntu. Un `[[`, un `local`, un tableau ou un
   * `echo -e` y échoue — et l'échec se produit sur le serveur du client, pas ici.
   */
  it("ne contient aucune construction propre à bash", () => {
    expect(PROBE_SCRIPT).not.toMatch(/\[\[/)
    // Ancré en début de ligne : `\blocal\b` matcherait `/usr/local/CyberCP` dans la
    // boucle de détection des panneaux, et ferait échouer un script parfaitement POSIX.
    expect(PROBE_SCRIPT).not.toMatch(/^\s*local\s/m)
    expect(PROBE_SCRIPT).not.toMatch(/\becho\s+-[en]/)
    expect(PROBE_SCRIPT).not.toMatch(/\$\(\(/)
  })

  /**
   * `echo` interprète les séquences d'échappement dans dash et pas dans bash : la même
   * ligne produirait une tabulation ici et deux caractères là.
   */
  it("n'émet que par printf", () => {
    expect(PROBE_SCRIPT).toContain("printf '%s\\t%s\\n'")
  })

  it("n'écrit rien et n'installe rien", () => {
    expect(PROBE_SCRIPT).not.toMatch(/\b(apt|apt-get|yum|dnf|curl|wget|rm|mv|cp|tee|install)\b/)
    expect(PROBE_SCRIPT).not.toMatch(/>\s*\/(?!dev\/null)/)
  })

  it("se termine par un marqueur de fin", () => {
    expect(PROBE_SCRIPT.trimEnd()).toMatch(/probe\.end 1$/)
  })
})

describe("parseProbe", () => {
  it("lit l'identité et les ressources de l'hôte", () => {
    const facts = parseProbe(
      raw(
        ["host.user", "root"],
        ["host.uid", "0"],
        ["host.arch", "x86_64"],
        ["host.os_id", "ubuntu"],
        ["host.os_version", "24.04"],
        ["host.os_name", "Ubuntu 24.04.1 LTS"],
        ["cpu.count", "4"],
        ["mem.total_mb", "7943"],
        ["swap.total_mb", "0"],
        ["disk.root", "203091120 178234880 8%"],
        ["access.elevate", "root"]
      )
    )

    expect(facts.host.osId).toBe("ubuntu")
    expect(facts.host.osVersion).toBe("24.04")
    expect(facts.resources.cpu).toBe(4)
    expect(facts.resources.memoryMb).toBe(7943)
    expect(facts.resources.diskUsePercent).toBe(8)
    expect(facts.access.elevate).toBe("root")
  })

  /**
   * Une bannière SSH, un message du jour ou un avertissement de `sudo` précèdent
   * couramment la sortie utile. Sans ce filtre, la première ligne du MOTD deviendrait
   * une clé de faits.
   */
  it("ignore tout ce qui précède l'en-tête et les lignes sans tabulation", () => {
    const facts = parseProbe(
      [
        "Welcome to Ubuntu 24.04.1 LTS",
        "  System information as of Tue Aug 19",
        "",
        "probe.version\t1",
        "host.os_id\tdebian",
        "une ligne sans tabulation",
        "probe.end\t1",
      ].join("\n")
    )

    expect(facts.host.osId).toBe("debian")
  })

  /**
   * Sans marqueur de fin, la sortie est tronquée — connexion coupée, script interrompu.
   * Analyser un constat partiel ferait classer en « vierge » un serveur dont on n'a
   * simplement pas lu les conteneurs.
   */
  it("refuse une sortie tronquée", () => {
    expect(() => parseProbe("probe.version\t1\nhost.os_id\tubuntu")).toThrow(/incomplet/i)
  })

  it("refuse une sortie sans en-tête", () => {
    expect(() => parseProbe("bonjour\n")).toThrow(/reconnaissance/i)
  })

  it("accumule les conteneurs et les réseaux Docker", () => {
    const facts = parseProbe(
      raw(
        ["docker.present", "oui"],
        ["docker.usable", "oui"],
        ["docker.version", "Docker version 27.3.1, build ce12230"],
        ["docker.compose", "oui"],
        ["docker.container", "skynode-caddy|caddy:2|running|0.0.0.0:80->80/tcp"],
        ["docker.container", "boutique|skynode/boutique:a1b2|running|"],
        ["docker.network", "bridge"],
        ["docker.network", "skynode"]
      )
    )

    expect(facts.docker.usable).toBe(true)
    expect(facts.docker.compose).toBe(true)
    expect(facts.docker.containers).toEqual([
      { name: "skynode-caddy", image: "caddy:2", state: "running", ports: "0.0.0.0:80->80/tcp" },
      { name: "boutique", image: "skynode/boutique:a1b2", state: "running", ports: "" },
    ])
    expect(facts.docker.networks).toEqual(["bridge", "skynode"])
  })

  it("rend Docker absent quand la sonde ne l'a pas trouvé", () => {
    const facts = parseProbe(raw(["docker.present", "non"]))

    expect(facts.docker.present).toBe(false)
    expect(facts.docker.usable).toBe(false)
    expect(facts.docker.containers).toEqual([])
  })

  it("analyse les lignes de ss, y compris sans nom de processus", () => {
    const facts = parseProbe(
      raw(
        ["listen", 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))'],
        ["listen", "LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*"],
        ["listen", "LISTEN 0 128 *:22 *:*"]
      )
    )

    expect(facts.listeners).toEqual([
      { address: "0.0.0.0", port: 80, process: "nginx" },
      { address: "127.0.0.1", port: 5432, process: null },
      { address: "*", port: 22, process: null },
    ])
  })

  /**
   * Sur une machine sans `ss`, le script bascule sur `netstat -lntp`, dont la sortie
   * s'ouvre sur deux lignes d'en-tête : sans filtre, elles deviendraient des écouteurs
   * fantômes. Le nom de processus s'y lit "<pid>/<nom>", pas "users:((...".
   */
  it("filtre les en-têtes de netstat et lit son format pid/nom", () => {
    const facts = parseProbe(
      raw(
        ["listen", "Active Internet connections (only servers)"],
        ["listen", "Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name"],
        ["listen", "tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      812/sshd"]
      )
    )

    expect(facts.listeners).toEqual([{ address: "0.0.0.0", port: 22, process: "sshd" }])
  })

  /**
   * `ss` entoure une adresse IPv6 de crochets (`[::]:80`), `netstat` ne le fait pas
   * (`:::80`) : sans normalisation, la même machine écouterait « différemment » selon
   * l'outil qui a répondu, et la classification compare l'adresse à une liste fixe.
   */
  it("normalise l'adresse IPv6 identiquement entre ss et netstat", () => {
    const facts = parseProbe(
      raw(
        ["listen", "LISTEN 0 128 [::]:80 [::]:*"],
        ["listen", "tcp6       0      0 :::80                   :::*                    LISTEN      -"]
      )
    )

    expect(facts.listeners).toEqual([
      { address: "::", port: 80, process: null },
      { address: "::", port: 80, process: null },
    ])
  })

  /**
   * Une ligne tronquée par une connexion coupée en cours de lecture ne doit pas devenir
   * un écouteur fantôme sur l'adresse vide et le port 0.
   */
  it("écarte les lignes de listen tronquées plutôt que d'inventer un écouteur", () => {
    const facts = parseProbe(raw(["listen", "LISTEN 0"], ["listen", ""]))

    expect(facts.listeners).toEqual([])
  })

  it("relève un panneau de contrôle", () => {
    const facts = parseProbe(raw(["panel", "aapanel /www/server/panel"]))

    expect(facts.panel).toEqual({ id: "aapanel", path: "/www/server/panel" })
  })

  /**
   * Le contrat « premier détecté l'emporte » vit dans l'ordre du `for` du script, pas
   * dans `parseProbe` : rien ne garde cet ordre, et un réordonnancement innocent de la
   * boucle le casserait sans faire échouer un seul test si celui-ci manquait.
   */
  it("retient le premier panneau détecté quand plusieurs coexistent", () => {
    const factsPlesk = parseProbe(
      raw(["panel", "plesk /usr/local/psa"], ["panel", "plesk /opt/psa"])
    )
    expect(factsPlesk.panel).toEqual({ id: "plesk", path: "/usr/local/psa" })

    const factsMix = parseProbe(
      raw(["panel", "aapanel /www/server/panel"], ["panel", "webmin /etc/webmin"])
    )
    expect(factsMix.panel).toEqual({ id: "aapanel", path: "/www/server/panel" })
  })

  it("décode l'état SkyNode", () => {
    const state = JSON.stringify({ recipe: 3, apps: ["boutique"] })
    const facts = parseProbe(
      raw(["skynode.present", "oui"], ["skynode.state_b64", Buffer.from(state).toString("base64")])
    )

    expect(facts.skynode.present).toBe(true)
    expect(facts.skynode.raw).toBe(state)
  })

  /**
   * L'état est un fichier que nous écrivons, mais une édition manuelle ou une troncature
   * arrive. Un constat entier ne doit pas être perdu pour cela.
   */
  it("survit à un état SkyNode illisible", () => {
    const facts = parseProbe(raw(["skynode.present", "oui"], ["skynode.state_b64", "@@@"]))

    expect(facts.skynode.present).toBe(true)
    expect(facts.skynode.raw).toBeNull()
  })

  /**
   * Une connexion coupée en cours de lecture du fichier d'état tronque le base64 sans
   * casser son alphabet : un décodage qui ne vérifie que les caractères rendrait alors
   * du JSON amputé, pris pour l'état réel.
   */
  it("rend null un état SkyNode tronqué plutôt qu'un JSON partiel", () => {
    const truncated = Buffer.from(JSON.stringify({ app: "boutique" }))
      .toString("base64")
      .slice(0, 15)
    const facts = parseProbe(
      raw(["skynode.present", "oui"], ["skynode.state_b64", truncated])
    )

    expect(facts.skynode.raw).toBeNull()
  })

  /**
   * Si les deux tentatives de `base64` du script échouent, la substitution de commande
   * rend une chaîne vide : indiscernable d'un fichier d'état vide si elle passait pour
   * du base64 valide, et `JSON.parse("")` lèverait chez l'appelant.
   */
  it("rend null un état SkyNode vide plutôt qu'une chaîne vide", () => {
    const facts = parseProbe(raw(["skynode.present", "oui"], ["skynode.state_b64", ""]))

    expect(facts.skynode.raw).toBeNull()
  })

  /**
   * `-T` verrouille des fins de ligne LF côté SSH (tâche 5), mais rien ici ne doit en
   * dépendre : un `\r` résiduel contamine chaque comparaison de valeur sans faire
   * échouer l'analyse — la pire panne, silencieuse.
   */
  it("ignore les retours chariot (CRLF) sans corrompre les valeurs", () => {
    const facts = parseProbe(
      raw(["docker.present", "oui"], ["access.elevate", "root"], ["cpu.count", "4"])
        .split("\n")
        .join("\r\n")
    )

    expect(facts.docker.present).toBe(true)
    expect(facts.access.elevate).toBe("root")
    expect(facts.resources.cpu).toBe(4)
  })

  it("applique des valeurs par défaut sûres aux clés absentes", () => {
    const facts = parseProbe(raw())

    expect(facts.resources.cpu).toBe(0)
    expect(facts.access.elevate).toBe("aucun")
    expect(facts.panel).toBeNull()
    expect(facts.binaries).toEqual([])
    expect(facts.listeners).toEqual([])
  })
})
