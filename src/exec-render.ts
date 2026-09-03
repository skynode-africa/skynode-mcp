import type { ExecReport, StepReport } from "./executor.js"
import { MAX_RESIDUS } from "./executor.js"
import { renderStep } from "./plan-render.js"
import type { Plan } from "./plan-types.js"

/**
 * Mise en forme française d'un rapport d'exécution.
 *
 * Le développeur lit ce texte pour décider s'il relance, s'il va voir, ou s'il n'a rien à
 * faire. Trois règles, dans cet ordre : **ce qui s'est passé en première ligne**, puis
 * l'état des étapes, puis — quand il y en a — **ce qui reste sur la machine**. Ce dernier
 * point est le seul qu'un échec rende indispensable : un rapport qui dit « échoué » sans
 * dire dans quel état la machine est restée oblige à aller voir à la main, ce que le produit
 * promet précisément d'éviter.
 *
 * Le diagnostic brut n'entre jamais ici. `runRemote` le borne déjà à mille caractères, mais
 * il n'a pas sa place dans un texte destiné à être lu : `step.detail` est la phrase que le
 * script a composée pour être lue, et c'est elle qu'on rend. Même discipline que
 * `plan-render.ts` et `report.ts`.
 */

/** Ce qu'un rapport peut peser sans cesser d'être lu. */
const MAX_CARACTERES = 2500

/** Un détail plus long que cela n'est plus une phrase, c'est un vidage. */
const MAX_DETAIL = 220

function borne(texte: string): string {
  return texte.length <= MAX_DETAIL ? texte : `${texte.slice(0, MAX_DETAIL - 1)}…`
}

const SYMBOLE: Record<StepReport["outcome"], string> = {
  applied: "appliqué",
  unchanged: "inchangé",
  failed: "ÉCHEC",
}

const DEFAIT: Record<NonNullable<StepReport["undone"]>, string> = {
  done: "défait",
  impossible: "non défait, cela ne se défait pas",
  failed: "ANNULATION EN ÉCHEC",
}

/**
 * `plan` est facultatif : sans lui, chaque étape se nomme par son type, ce qui n'apprend
 * rien au développeur. Avec lui, `renderStep` la dit dans son vocabulaire. L'exécuteur a le
 * plan sous la main ; un appelant qui ne l'aurait pas obtient tout de même un rapport
 * lisible, plutôt qu'un refus de formater.
 */
export function formatExecReport(report: ExecReport, plan?: Plan): string {
  const lignes: string[] = []

  if (report.dryRun) {
    lignes.push(
      "Simulation : rien n'a été exécuté sur le serveur, aucune session n'a été ouverte."
    )
  } else if (report.outcome === "applied") {
    lignes.push("Plan appliqué : le déploiement est allé au bout.")
  } else if (report.outcome === "unchanged") {
    lignes.push("Plan appliqué sans changement : la machine était déjà dans l'état voulu.")
  } else {
    lignes.push("Plan en échec : le déploiement s'est arrêté avant la fin.")
  }

  if (report.transfert !== undefined) {
    lignes.push("", report.transfert.ok ? `Transfert : ${borne(report.transfert.detail)}` : `Transfert en échec : ${borne(report.transfert.detail)}`)
  }

  lignes.push("", "Étapes :")
  report.steps.forEach((etape) => {
    const nom = plan?.etapes[etape.index]
    const quoi = nom === undefined ? etape.type : renderStep(nom)
    const defait = etape.undone === undefined ? "" : ` — ${DEFAIT[etape.undone]}`

    lignes.push(`${etape.index + 1}. [${SYMBOLE[etape.outcome]}${defait}] ${quoi}`)
    if (etape.detail !== "") lignes.push(`   ${borne(etape.detail)}`)

    // Le durcissement SSH se lit sur sa propre ligne : il n'est pas le fait du script de
    // l'étape, et son échec — le seul du produit qui soit irréparable à distance s'il
    // tournait mal — ne doit pas se confondre avec le reste du compte rendu.
    if (etape.durcissement !== undefined) {
      lignes.push(
        `   [SSH ${SYMBOLE[etape.durcissement.outcome]}] ${borne(etape.durcissement.detail)}`
      )
    }
  })

  if (report.residue.length > 0) {
    lignes.push("", "Ce qui reste sur la machine :")
    report.residue.slice(0, MAX_RESIDUS).forEach((ligne) => {
      lignes.push(`- ${borne(ligne)}`)
    })
    if (report.residue.length > MAX_RESIDUS) {
      lignes.push(`- … et ${report.residue.length - MAX_RESIDUS} autre(s), non listés ici.`)
    }
  } else if (report.outcome === "failed" && !report.dryRun) {
    // Le dire explicitement, plutôt que de laisser l'absence de section se lire comme un
    // oubli : « rien ne reste » est une information, et c'est celle que le développeur
    // cherche en premier après un échec.
    lignes.push("", "Rien ne reste de ce passage : tout ce qui avait été appliqué a été défait.")
  }

  const texte = lignes.join("\n")

  // Le seuil vaut pour ce que l'agent recopiera dans son contexte. Couper à l'aveugle vaut
  // mieux que rendre un rapport de plusieurs milliers de lignes, mais la coupure se voit.
  return texte.length <= MAX_CARACTERES
    ? texte
    : `${texte.slice(0, MAX_CARACTERES - 1)}\n[rapport tronqué]`
}
