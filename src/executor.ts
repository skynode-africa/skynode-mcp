import { runRemote, type Outcome } from "./remote.js"
import type { Plan, PlanStep } from "./plan-types.js"
import { APPLICATION_PATTERN, exigeMotif } from "./plan-rules.js"
import { renderStep } from "./plan-render.js"
import type { SshRunner, SshTarget } from "./ssh.js"
import {
  isReversible,
  recipeFor,
  verifieConformiteScript,
  type StepContext,
  type StepRecipe,
} from "./step.js"
import { hardenSsh, type HardenResult } from "./ssh-harden.js"
import { repertoireAPreserver } from "./steps-build.js"
import { UTILISATEUR_APPLICATIF } from "./steps-host.js"
import { transferProject, type TransferResult } from "./transfer.js"

/**
 * L'exécution d'un plan approuvé : les étapes dans l'ordre, l'arrêt à la première qui
 * échoue, et le retour arrière de celles qui avaient déjà changé quelque chose.
 *
 * **C'est la pièce qui décide de ce qu'un serveur devient quand quelque chose tourne mal.**
 * Un serveur laissé à mi-chemin est le pire résultat possible (invariant n°4) : ni l'ancien
 * état, ni le nouveau, et un agent qui n'a aucun moyen de savoir où il en est. D'où quatre
 * règles, qu'aucune simplification ne doit relâcher :
 *
 * - **Tous les scripts sont composés avant que le premier ne s'exécute.** Une recette qui
 *   refuse une valeur — un nom d'application hostile, un fichier d'environnement hors du
 *   dépôt — lève à la composition. La faire lever au milieu du plan laisserait une machine
 *   à moitié déployée pour une faute que rien n'obligeait à découvrir si tard.
 * - **L'annulation ne s'arrête jamais à la première erreur.** Elle poursuit et rapporte
 *   tout : s'arrêter laisserait plus de résidu que nécessaire, et personne pour le nommer.
 * - **Une étape restée `unchanged` ne se défait pas.** Elle n'avait rien changé ; la défaire
 *   retirerait un Caddy que le client avait posé lui-même avant nous.
 * - **`dryRun` n'ouvre aucune session.** Il compose, il décrit, il n'exécute rien — ni
 *   étape, ni transfert.
 */

/** Où l'arborescence transférée atterrit, une racine par application. */
export const RACINE_TRAVAIL = "/opt/skynode/work"

/** Combien de résidus le rapport nomme avant de s'en tenir à un compte. */
export const MAX_RESIDUS = 10

/**
 * Les étapes qui lisent l'arborescence transférée. Le transfert n'est pas une étape du plan
 * — il ne s'annule pas, il n'a rien à déclarer à l'humain qui approuve — mais sans lui ces
 * trois-là échoueraient toutes sur le même prérequis absent.
 */
const ETAPES_QUI_LISENT_LE_PROJET: ReadonlyArray<PlanStep["type"]> = [
  "build.generate_dockerfile",
  "build.image",
  "app.run",
]

export interface StepReport {
  index: number
  type: PlanStep["type"]
  outcome: Outcome
  detail: string
  /** Rempli seulement quand l'exécuteur a tenté de défaire cette étape. */
  undone?: "done" | "impossible" | "failed"
  /**
   * Le durcissement SSH, quand l'étape l'a réclamé par `needsSecondSession`. Il est rendu
   * à part de `detail` parce qu'il n'est pas le fait du script de l'étape : il ouvre ses
   * propres sessions, et son échec doit pouvoir se lire sans être confondu avec le reste.
   */
  durcissement?: { outcome: Outcome; detail: string }
}

/** Le transfert préalable, quand le plan en a eu besoin. Absent sinon, et absent en `dryRun`. */
export interface TransferReport {
  ok: boolean
  detail: string
}

export interface ExecReport {
  outcome: "applied" | "unchanged" | "failed"
  steps: StepReport[]
  transfert?: TransferReport
  /** Ce qui n'a pas pu être défait, et que le développeur doit savoir. */
  residue: string[]
  dryRun: boolean
}

/** Ce que l'exécuteur appelle pour transférer, injectable pour que les tests n'ouvrent rien. */
export type TransferFn = (
  target: SshTarget,
  racine: string,
  workDir: string,
  preserveDir: string | null
) => Promise<TransferResult>

/** Ce que l'exécuteur appelle pour durcir SSH, injectable pour que les tests n'ouvrent rien. */
export type HardenFn = (
  ssh: SshRunner,
  cible: SshTarget,
  utilisateur: string
) => Promise<HardenResult>

export interface ExecOptions {
  dryRun: boolean
  transfer?: TransferFn
  harden?: HardenFn
  /**
   * La recette d'un type, `recipeFor` par défaut. Injectable pour la même raison que
   * `transfer` : c'est le seul moyen d'éprouver que l'exécuteur **refuse** un script non
   * conforme, puisque les neuf recettes réelles le sont toutes et que `RECIPES` est gelé.
   * Le harnais de conformité est le dernier filet avant qu'un script s'exécute en root ;
   * un branchement qu'aucun test ne traverse est un filet dont rien ne dit qu'il est tendu.
   */
  recipes?: (type: PlanStep["type"]) => StepRecipe
}

/**
 * Le répertoire de travail d'une application.
 *
 * `APPLICATION_PATTERN` est le contrôle qui autorise l'interpolation : ce chemin finit dans
 * un `rm -rf` joué en root par le script de réception (`transfer.ts`), qui le revalide de
 * son côté par `exigeRepertoireDeTravail`.
 */
export function repertoireDeTravail(application: string): string {
  return `${RACINE_TRAVAIL}/${exigeMotif(application, APPLICATION_PATTERN, "un nom d'application valide")}`
}

/**
 * Ce qui reste sur la machine quand une étape ne s'est pas défaite.
 *
 * Le texte s'adresse au développeur, pas à l'agent : il doit pouvoir décider s'il relance ou
 * s'il va voir. Nommer l'étape par son type ne lui apprendrait rien — `renderStep` dit ce
 * qu'elle faisait, dans son vocabulaire à lui.
 */
function residuDe(step: PlanStep, raison: "impossible" | "failed"): string {
  return raison === "impossible"
    ? `Non défait, parce que cela ne se défait pas : ${renderStep(step)}.`
    : `L'annulation a échoué : ${renderStep(step)}. À vérifier à la main.`
}

/** Les scripts d'une étape, composés d'avance — et conformes, ou l'on ne part pas. */
interface EtapePrete {
  index: number
  step: PlanStep
  script: string
  undoScript: string | null
}

/**
 * Compose et contrôle tous les scripts du plan.
 *
 * `verifieConformiteScript` est le harnais du jalon (`step.ts`) : marqueur de fin, absence
 * de bashisme, absence de `local`, garde d'idempotence. Le passer ici plutôt qu'au fil de
 * l'exécution, c'est refuser un plan défectueux **avant** d'avoir touché la machine.
 */
function preparerEtapes(
  plan: Plan,
  ctx: StepContext,
  pourType: (type: PlanStep["type"]) => StepRecipe
): EtapePrete[] {
  return plan.etapes.map((step, index) => {
    const recette = pourType(step.type)

    verifieConformiteScript(step.type, step, ctx, recette)

    return {
      index,
      step,
      script: recette.script(step, ctx),
      undoScript: recette.undoScript(step, ctx),
    }
  })
}

/** Le rapport d'un plan qu'on refuse de commencer : rien n'a été exécuté, rien ne reste. */
function refus(plan: Plan, detail: string, dryRun: boolean): ExecReport {
  return {
    outcome: "failed",
    steps: plan.etapes.map((step, index) => ({
      index,
      type: step.type,
      outcome: "failed" as const,
      detail:
        index === 0
          ? detail
          : "Non exécutée : le plan a été refusé avant que la première étape ne s'exécute.",
    })),
    residue: [],
    dryRun,
  }
}

export async function executePlan(
  plan: Plan,
  ssh: SshRunner,
  target: SshTarget,
  ctx: { projectRoot: string },
  options: ExecOptions
): Promise<ExecReport> {
  let contexte: StepContext
  let pretes: EtapePrete[]
  try {
    // Le contexte se compose **dans** le même essai que les scripts : `repertoireDeTravail`
    // refuse un nom d'application hors motif, et cette fonction ne doit jamais lever — un
    // exécuteur qui remonte une exception ne dit rien de l'état de la machine, alors qu'un
    // rapport en échec dit qu'elle n'a pas été touchée.
    contexte = {
      application: plan.application,
      projectRoot: ctx.projectRoot,
      workDir: repertoireDeTravail(plan.application),
    }
    pretes = preparerEtapes(plan, contexte, options.recipes ?? recipeFor)
  } catch (erreur) {
    // Une recette qui refuse une valeur, ou un script non conforme : le plan ne commence
    // pas. Le message vient de la recette et est déjà en français.
    return refus(plan, erreur instanceof Error ? erreur.message : String(erreur), options.dryRun)
  }

  if (options.dryRun) {
    return {
      outcome: "unchanged",
      steps: pretes.map(({ index, step }) => ({
        index,
        type: step.type,
        // Aucune session n'a été ouverte : la seule chose honnête à déclarer est que rien
        // n'a changé, et à dire ce que l'étape aurait fait.
        outcome: "unchanged" as const,
        detail: `Simulation : ${renderStep(step)}.`,
      })),
      residue: [],
      dryRun: true,
    }
  }

  const steps: StepReport[] = []
  const residue: string[] = []
  const aDefaire: EtapePrete[] = []
  let transfert: TransferReport | undefined

  // Le transfert d'abord, et seulement si le plan en a l'usage : un plan qui ne fait
  // qu'installer Caddy n'a pas de projet à envoyer.
  if (plan.etapes.some((step) => ETAPES_QUI_LISENT_LE_PROJET.includes(step.type))) {
    const genere = plan.etapes.find((step) => step.type === "build.generate_dockerfile")
    const transferer = options.transfer ?? ((cible, racine, workDir, preserve) =>
      transferProject(cible, racine, workDir, preserve))

    const resultat = await transferer(
      target,
      ctx.projectRoot,
      contexte.workDir,
      // Le répertoire de sortie d'un site statique déjà construit est exclu par le
      // `.dockerignore` ; sans lui, on transférerait un dépôt amputé de ce qu'il faut servir.
      genere === undefined ? null : repertoireAPreserver(genere)
    )

    transfert = { ok: resultat.ok, detail: resultat.detail }

    if (!resultat.ok) {
      return {
        outcome: "failed",
        steps: plan.etapes.map((step, index) => ({
          index,
          type: step.type,
          outcome: "failed" as const,
          detail: "Non exécutée : le projet n'a pas pu être transféré.",
        })),
        transfert,
        // Le script de réception vide le répertoire de travail avant d'extraire : ce qu'il
        // laisse est une arborescence partielle, pas un déploiement à moitié fait.
        residue: [],
        dryRun: false,
      }
    }
  }

  let echoue = false

  for (const prete of pretes) {
    const resultat = await runRemote(ssh, target, prete.script)

    steps.push({
      index: prete.index,
      type: prete.step.type,
      outcome: resultat.outcome,
      detail: resultat.detail,
    })

    if (resultat.outcome === "failed") {
      echoue = true
      break
    }

    // Seules les étapes qui ont **changé** quelque chose entrent dans la pile : défaire une
    // étape restée `unchanged` retirerait quelque chose qu'on n'a pas posé.
    if (resultat.outcome === "applied") aDefaire.push(prete)

    // Le durcissement SSH ne peut pas être un script d'étape : son filet exige d'ouvrir de
    // vraies sessions en tant que compte applicatif, avant puis après avoir coupé le mot de
    // passe. La recette le déclare, l'exécuteur — seul à détenir le `SshRunner` — l'exécute.
    //
    // Il se joue aussi après un `unchanged` : une machine déjà préparée peut très bien
    // n'avoir jamais été durcie, parce qu'un passage précédent s'est arrêté ici même.
    // `hardenSsh` est idempotent, le rejouer ne coûte que trois sessions.
    if (recipeFor(prete.step.type).needsSecondSession === true) {
      const durcir = options.harden ?? hardenSsh
      const durcissement = await durcir(ssh, target, UTILISATEUR_APPLICATIF)
      const rapport = steps[steps.length - 1]
      if (rapport !== undefined) {
        rapport.durcissement = { outcome: durcissement.outcome, detail: durcissement.detail }
      }

      // Un durcissement en échec arrête le plan. `hardenSsh` a déjà retiré son fichier et
      // vérifié que la porte se rouvre : la machine est dans l'état d'avant, et poursuivre
      // livrerait une application sur un serveur dont on sait qu'on n'a pas su fermer la
      // porte — la promesse faite au client, précisément.
      if (durcissement.outcome === "failed") {
        echoue = true
        break
      }
    }
  }

  if (!echoue) {
    return {
      outcome: steps.some((s) => s.outcome === "applied") ? "applied" : "unchanged",
      steps,
      ...(transfert === undefined ? {} : { transfert }),
      residue,
      dryRun: false,
    }
  }

  // En ordre inverse : la dernière étape appliquée est la première défaite. L'ordre est la
  // garantie — retirer une image avant le conteneur qui s'en sert échouerait sur le premier
  // geste et laisserait tout le reste en place.
  for (const prete of [...aDefaire].reverse()) {
    const rapport = steps.find((s) => s.index === prete.index)
    if (rapport === undefined) continue

    if (prete.undoScript === null || !isReversible(prete.step)) {
      rapport.undone = "impossible"
      residue.push(residuDe(prete.step, "impossible"))
      continue
    }

    const resultat = await runRemote(ssh, target, prete.undoScript)

    if (resultat.outcome === "failed") {
      rapport.undone = "failed"
      residue.push(residuDe(prete.step, "failed"))
      // On poursuit : s'arrêter ici laisserait défaites les étapes tardives et intactes les
      // premières, l'état le plus difficile à diagnostiquer de tous.
      continue
    }

    rapport.undone = "done"
  }

  return {
    outcome: "failed",
    steps,
    ...(transfert === undefined ? {} : { transfert }),
    residue,
    dryRun: false,
  }
}
