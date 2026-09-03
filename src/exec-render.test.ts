import { describe, expect, it } from "vitest"

import { formatExecReport } from "./exec-render.js"
import type { ExecReport } from "./executor.js"
import type { Plan } from "./plan-types.js"

const PLAN: Plan = {
  version: 1,
  id: "plan_abcd1234",
  serveur: "vps-1",
  regime: "docker",
  empreinte_etat: `sha256:${"0".repeat(64)}`,
  application: "boutique",
  resume: "déployer boutique",
  etapes: [
    { type: "host.install_docker" },
    { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
    { type: "app.run", port_interne: 3000, reseau: "skynode" },
  ],
  hors_perimetre: [],
  reversible: false,
}

function rapport(partiel: Partial<ExecReport> = {}): ExecReport {
  return {
    outcome: "applied",
    steps: PLAN.etapes.map((etape, index) => ({
      index,
      type: etape.type,
      outcome: "applied" as const,
      detail: "fait",
    })),
    residue: [],
    dryRun: false,
    ...partiel,
  }
}

describe("formatExecReport", () => {
  it("dit en première ligne ce qui s'est passé", () => {
    expect(formatExecReport(rapport({ outcome: "applied" })).split("\n")[0]).toMatch(/appliqué/i)
    expect(formatExecReport(rapport({ outcome: "failed" })).split("\n")[0]).toMatch(/échec/i)
    expect(formatExecReport(rapport({ outcome: "unchanged" })).split("\n")[0]).toMatch(/sans changement/i)
  })

  /** Un rapport d'échec doit dire dans quel état la machine est restée. */
  it("nomme le résidu quand il y en a", () => {
    const t = formatExecReport(rapport({ outcome: "failed", residue: ["Docker reste installé"] }))

    expect(t).toMatch(/Docker reste installé/)
    expect(t).toMatch(/reste sur la machine/i)
  })

  /**
   * « Rien ne reste » est une information, et c'est la première que le développeur cherche
   * après un échec : l'absence de section se lirait comme un oubli.
   */
  it("dit explicitement quand rien ne reste", () => {
    expect(formatExecReport(rapport({ outcome: "failed" }))).toMatch(/Rien ne reste/)
  })

  it("dit clairement qu'un dryRun n'a rien exécuté", () => {
    expect(formatExecReport(rapport({ dryRun: true }))).toMatch(/rien n'a été exécuté/i)
  })

  /** Un échec de transfert est la seule chose qui explique un plan qui n'a rien joué. */
  it("rend le transfert quand il y en a eu un", () => {
    const t = formatExecReport(
      rapport({ outcome: "failed", transfert: { ok: false, detail: "Transfert interrompu." } })
    )

    expect(t).toMatch(/Transfert en échec/)
    expect(t).toMatch(/Transfert interrompu\./)
  })

  it("ne mentionne pas le transfert quand il n'y en a pas eu", () => {
    expect(formatExecReport(rapport())).not.toMatch(/Transfert/)
  })

  /** L'état de chaque annulation se lit, sinon le résidu seul ne dit pas ce qui a été défait. */
  it("dit pour chaque étape si elle a été défaite", () => {
    const t = formatExecReport(
      rapport({
        outcome: "failed",
        steps: [
          { index: 0, type: "host.install_docker", outcome: "applied", detail: "", undone: "impossible" },
          { index: 1, type: "build.image", outcome: "applied", detail: "", undone: "failed" },
          { index: 2, type: "app.run", outcome: "failed", detail: "mort au démarrage" },
        ],
      }),
      PLAN
    )

    expect(t).toMatch(/non défait, cela ne se défait pas/)
    expect(t).toMatch(/ANNULATION EN ÉCHEC/)
    expect(t).toMatch(/mort au démarrage/)
  })

  /** Avec le plan, l'étape se nomme dans le vocabulaire du développeur, pas par son type. */
  it("nomme les étapes en français quand le plan est fourni", () => {
    const t = formatExecReport(rapport(), PLAN)

    expect(t).toMatch(/installer Docker/)
    expect(t).not.toMatch(/host\.install_docker/)
  })

  /** Sans le plan, un rapport lisible vaut mieux qu'un refus de formater. */
  it("se rabat sur le type quand le plan manque", () => {
    expect(formatExecReport(rapport())).toMatch(/host\.install_docker/)
  })

  it("ne rend jamais de diagnostic brut de plusieurs milliers de lignes", () => {
    const enorme = rapport({
      outcome: "failed",
      steps: [{ index: 0, type: "app.run", outcome: "failed", detail: "x".repeat(50_000) }],
      residue: Array.from({ length: 200 }, (_, i) => `résidu ${i} ${"y".repeat(500)}`),
    })

    expect(formatExecReport(enorme).length).toBeLessThan(3000)
  })

  /**
   * Le plafond global n'est pas un doublon des bornes par ligne : un plan porte jusqu'à
   * trente étapes (`PlanSchema`), et trente détails chacun sous sa borne dépassent ensemble
   * ce qu'un agent doit recopier dans son contexte. C'est ce cas-là, et lui seul, qui
   * l'atteint — sans ce test, le plafond pourrait disparaître sans qu'un test meure.
   */
  it("borne aussi un rapport dont chaque ligne est pourtant courte", () => {
    const long = rapport({
      outcome: "failed",
      steps: Array.from({ length: 30 }, (_, index) => ({
        index,
        type: "app.run" as const,
        outcome: "applied" as const,
        detail: "d".repeat(200),
        undone: "done" as const,
      })),
    })
    const texte = formatExecReport(long)

    expect(texte.length).toBeLessThan(3000)
    expect(texte).toMatch(/\[rapport tronqué\]/)
  })

  /** Une liste de résidus bornée doit dire qu'elle l'est, sinon elle ment par omission. */
  it("annonce les résidus qu'il ne liste pas", () => {
    const t = formatExecReport(
      rapport({ outcome: "failed", residue: Array.from({ length: 14 }, (_, i) => `résidu ${i}`) })
    )

    expect(t).toMatch(/4 autre\(s\), non listés/)
  })
})
