import { describe, expect, it } from "vitest"

import { computeFingerprint } from "./fingerprint.js"
import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"

/**
 * Recopié depuis `src/regime.test.ts` à dessein : un constructeur commun finit par porter
 * les besoins de tous les tests et cesse de dire, dans sa ligne d'appel, ce qui décide du
 * cas. Reprends-le tel quel, avec son type deep-partial local.
 */
/** Recopié depuis `src/regime.test.ts` (l. 11-13) — voir la note ci-dessus. */
type Deep<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Deep<T[K]>) : T[K]
}

function facts(partial: Deep<ServerFacts> = {}): ServerFacts {
  return {
    host: { user: "root", uid: 0, arch: "x86_64", kernel: "6.8.0",
            osId: "ubuntu", osVersion: "24.04", osName: "Ubuntu 24.04.1 LTS", ...partial.host },
    resources: { cpu: 4, memoryMb: 7943, swapMb: 0, diskUsePercent: 8, ...partial.resources },
    access: { elevate: "root", ...partial.access },
    docker: { present: false, usable: false, version: "", compose: false,
              containers: [], networks: [], ...partial.docker },
    podmanPresent: partial.podmanPresent ?? false,
    binaries: partial.binaries ?? [],
    listeners: partial.listeners ?? [],
    services: partial.services ?? [],
    panel: partial.panel ?? null,
    skynode: { present: false, raw: null, ...partial.skynode },
  }
}

function classification(partial: Partial<Classification> = {}): Classification {
  return {
    regime: "vierge", executable: true,
    because: "aucun service web, Docker absent, Ubuntu 24.04 en root",
    blockers: [], guidance: [], ...partial,
  }
}

describe("computeFingerprint", () => {
  it("rend une empreinte au format attendu", () => {
    expect(computeFingerprint(facts(), classification())).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("rend la même empreinte pour les mêmes faits", () => {
    expect(computeFingerprint(facts(), classification()))
      .toBe(computeFingerprint(facts(), classification()))
  })

  /**
   * Le cœur du mécanisme : ces changements-là doivent invalider un plan, parce qu'ils
   * changent ce que le plan doit faire.
   */
  it.each([
    ["le régime", () => classification({ regime: "docker" }), undefined],
    ["la présence de Docker", undefined, () => facts({ docker: { present: true, usable: true } })],
    ["le détenteur du port 80", undefined,
      () => facts({ listeners: [{ address: "0.0.0.0", port: 80, process: "nginx" }] })],
    ["la présence d'un état SkyNode", undefined,
      () => facts({ skynode: { present: true, raw: "{}" } })],
    ["la présence d'un panneau", undefined,
      () => facts({ panel: { id: "aapanel", path: "/www/server/panel" } })],
    ["l'apparition de nginx", undefined, () => facts({ binaries: ["nginx"] })],
    ["l'apparition d'apache2", undefined, () => facts({ binaries: ["apache2"] })],
  ])("change quand %s change", (_nom, autreClass, autreFacts) => {
    const base = computeFingerprint(facts(), classification())
    const modifie = computeFingerprint(
      autreFacts ? autreFacts() : facts(),
      autreClass ? autreClass() : classification()
    )

    expect(modifie).not.toBe(base)
  })

  /**
   * Et ceux-là ne doivent PAS l'invalider. Une empreinte qui bouge à chaque seconde ferait
   * échouer tout plan au moment de l'appliquer, et on finirait par désactiver la
   * protection — qui ne protégerait alors plus rien.
   */
  it.each([
    ["la mémoire libre", () => facts({ resources: { cpu: 4, memoryMb: 512, swapMb: 0, diskUsePercent: 8 } })],
    ["l'occupation du disque", () => facts({ resources: { cpu: 4, memoryMb: 7943, swapMb: 0, diskUsePercent: 71 } })],
    ["le noyau", () => facts({ host: { user: "root", uid: 0, arch: "x86_64", kernel: "6.11.0",
                                       osId: "ubuntu", osVersion: "24.04", osName: "Ubuntu 24.04.1 LTS" } })],
    ["la liste des services", () => facts({ services: ["ssh.service", "cron.service"] })],
    ["les réseaux Docker", () => facts({ docker: { present: false, usable: false, version: "",
                                                   compose: false, containers: [], networks: ["bridge"] } })],
    ["des binaires hors des quatre retenus",
      () => facts({ binaries: ["git", "tar", "certbot", "rsync"] })],
  ])("ne change pas quand %s change", (_nom, autreFacts) => {
    expect(computeFingerprint(autreFacts(), classification()))
      .toBe(computeFingerprint(facts(), classification()))
  })

  /**
   * Un conteneur applicatif de plus ne doit pas invalider un plan — mais Caddy, si :
   * sa présence décide si `proxy.caddy.install` a lieu d'être.
   */
  it("ignore les conteneurs applicatifs mais retient Caddy", () => {
    const avecApp = facts({
      docker: { present: true, usable: true, version: "", compose: true, networks: [],
                containers: [{ name: "boutique", image: "skynode/boutique:a1", state: "running", ports: "" }] },
    })
    const avecCaddy = facts({
      docker: { present: true, usable: true, version: "", compose: true, networks: [],
                containers: [{ name: "skynode-caddy", image: "caddy:2", state: "running", ports: "0.0.0.0:80->80/tcp" }] },
    })
    const sansRien = facts({ docker: { present: true, usable: true, version: "", compose: true,
                                       networks: [], containers: [] } })

    expect(computeFingerprint(avecApp, classification())).toBe(computeFingerprint(sansRien, classification()))
    expect(computeFingerprint(avecCaddy, classification())).not.toBe(computeFingerprint(sansRien, classification()))
  })

  /**
   * L'ordre dans lequel `ss` ou `docker ps` rendent leurs lignes n'est pas garanti.
   * Sans tri, la même machine produirait deux empreintes différentes à une seconde
   * d'intervalle, et aucun plan ne survivrait à sa propre production.
   */
  it("ne dépend pas de l'ordre des écoutes", () => {
    const ordre1 = facts({ listeners: [
      { address: "0.0.0.0", port: 80, process: "nginx" },
      { address: "::", port: 443, process: "nginx" },
    ] })
    const ordre2 = facts({ listeners: [
      { address: "::", port: 443, process: "nginx" },
      { address: "0.0.0.0", port: 80, process: "nginx" },
    ] })

    expect(computeFingerprint(ordre1, classification())).toBe(computeFingerprint(ordre2, classification()))
  })

  it("ne retient des écoutes que celles des ports 80 et 443", () => {
    const avec8080 = facts({ listeners: [{ address: "0.0.0.0", port: 8080, process: "app" }] })

    expect(computeFingerprint(avec8080, classification())).toBe(computeFingerprint(facts(), classification()))
  })

  /** Pendant du test d'ordre sur les écoutes : garde le tri appliqué à `binaires`. */
  it("ne dépend pas de l'ordre des binaires", () => {
    const ordre1 = facts({ binaries: ["nginx", "caddy"] })
    const ordre2 = facts({ binaries: ["caddy", "nginx"] })

    expect(computeFingerprint(ordre1, classification())).toBe(computeFingerprint(ordre2, classification()))
  })

  /**
   * La sérialisation passe par un tableau JSON, jamais par une concaténation : sans quoi
   * `["nginxcaddy"]` et `["nginx", "caddy"]` produiraient la même chaîne à hacher.
   */
  it("ne confond pas une liste de binaires avec leur concaténation", () => {
    const concatene = facts({ binaries: ["nginxcaddy"] })
    const distincts = facts({ binaries: ["nginx", "caddy"] })

    expect(computeFingerprint(concatene, classification())).not.toBe(
      computeFingerprint(distincts, classification())
    )
  })
})
