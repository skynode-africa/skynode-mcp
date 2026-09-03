import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

import { executePlan, repertoireDeTravail, type ExecReport, type HardenFn, type TransferFn } from "./executor.js"
import type { Plan, PlanStep } from "./plan-types.js"
import type { SshResult, SshRunner, SshTarget } from "./ssh.js"
import type { StepRecipe } from "./step.js"

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "next-sans-dockerfile")

const CIBLE: SshTarget = { host: "192.0.2.10", user: "root" }
const CTX = { projectRoot: RACINE }

/**
 * Un plan complet et valide — les mêmes valeurs que `plan-types.ts` accepte. Un plan
 * approximatif ne prouverait rien de ce que l'exécuteur recevra vraiment.
 *
 * Dépôt public : l'hôte est en `192.0.2.0/24` et le domaine en `exemple.ci`.
 */
function plan(etapes?: PlanStep[]): Plan {
  return {
    version: 1,
    id: "plan_abcd1234",
    serveur: "vps-1",
    regime: "docker",
    empreinte_etat: `sha256:${"0".repeat(64)}`,
    application: "boutique",
    resume: "déployer boutique",
    etapes: etapes ?? [
      { type: "proxy.caddy.install" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
    ],
    hors_perimetre: [],
    reversible: true,
  }
}

const planAvecEquipement = (): Plan =>
  plan([
    { type: "host.install_docker" },
    { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
    { type: "app.run", port_interne: 3000, reseau: "skynode" },
  ])

/* ------------------------------------------------------- un serveur qui joue le jeu --- */

/**
 * Reconnaît une étape à son script. L'exécuteur ne dit pas au serveur quel type il joue —
 * c'est le script seul qui traverse SSH — donc le double de serveur doit le déduire comme
 * un vrai serveur le ferait : par ce qu'il lit.
 */
function etiquette(script: string): string {
  const prefixe = script.includes("rien à défaire") || script.includes("à défaire.") ? "undo:" : ""

  if (script.includes("docker run -d --name boutique")) return "app.run"
  if (script.includes("docker rm -f boutique")) return "undo:app.run"
  if (script.includes("docker build --tag")) return "build.image"
  if (script.includes("Aucune image $image sur cette machine")) return "undo:build.image"
  if (script.includes("skynode-caddy")) return `${prefixe}proxy.caddy.install`
  if (script.includes("apt-get") && script.includes("docker-ce")) return "host.install_docker"
  if (script.includes("state.d")) return `${prefixe}state.record`

  return `${prefixe}inconnu`
}

const sortie = (outcome: string, detail: string): SshResult => ({
  code: 0,
  stdout: `step.outcome\t${outcome}\nstep.detail\t${detail}\nstep.end\t1\n`,
  stderr: "",
})

const ok = (): SshResult => sortie("applied", "fait")
const rien = (): SshResult => sortie("unchanged", "rien à faire")
const echec = (pourquoi: string): SshResult => sortie("failed", pourquoi)

/** Le transfert est injecté : aucun test n'ouvre de vrai tuyau `tar | ssh`. */
const transfertReussi: TransferFn = async () => ({
  ok: true,
  fichiers: 5,
  detail: "Arborescence transférée.",
  diagnostic: "",
})

const transfertEchoue: TransferFn = async () => ({
  ok: false,
  fichiers: null,
  detail: "Transfert interrompu : le serveur n'a pas rendu son marqueur de fin.",
  diagnostic: "",
})

function serveur(reponse: (etiquette: string) => SshResult, vus?: string[]): SshRunner {
  return {
    run: async (_cible: SshTarget, script: string): Promise<SshResult> => {
      const t = etiquette(script)
      vus?.push(t)
      return reponse(t)
    },
  }
}

/** Le durcissement est injecté : aucun test n'ouvre de vraie session vers un vrai hôte. */
const durcissementReussi: HardenFn = async () => ({
  outcome: "applied",
  detail: "Mot de passe et connexion root directe refusés.",
  diagnostic: "",
})

const joue = (
  p: Plan,
  ssh: SshRunner,
  dryRun = false,
  transfer: TransferFn = transfertReussi,
  harden: HardenFn = durcissementReussi
): Promise<ExecReport> => executePlan(p, ssh, CIBLE, CTX, { dryRun, transfer, harden })

/* --------------------------------------------------------------- le chemin nominal --- */

describe("executePlan — le chemin nominal", () => {
  it("exécute les étapes dans l'ordre du plan", async () => {
    const vus: string[] = []
    await joue(plan(), serveur(() => ok(), vus))

    expect(vus).toEqual(["proxy.caddy.install", "build.image", "app.run"])
  })

  it("rend applied quand au moins une étape a changé quelque chose", async () => {
    expect((await joue(plan(), serveur(() => ok()))).outcome).toBe("applied")
  })

  it("rend unchanged quand aucune étape n'a rien changé", async () => {
    expect((await joue(plan(), serveur(() => rien()))).outcome).toBe("unchanged")
  })

  /** Le transfert précède la première étape : sans lui, elles échoueraient toutes sur lui. */
  it("transfère le projet avant la première étape qui le lit", async () => {
    const ordre: string[] = []
    const transfer: TransferFn = async () => {
      ordre.push("transfert")
      return { ok: true, fichiers: 5, detail: "ok", diagnostic: "" }
    }
    await joue(plan(), serveur(() => ok(), ordre), false, transfer)

    expect(ordre[0]).toBe("transfert")
  })

  /** Un plan qui n'a rien à construire n'a rien à transférer. */
  it("ne transfère pas quand aucune étape ne lit le projet", async () => {
    const transfer = vi.fn(transfertReussi)
    const r = await joue(plan([{ type: "proxy.caddy.install" }]), serveur(() => ok()), false, transfer)

    expect(transfer).not.toHaveBeenCalled()
    expect(r.transfert).toBeUndefined()
  })

  /** Un transfert manqué n'est pas un déploiement à moitié fait : aucune étape n'a tourné. */
  it("n'exécute aucune étape si le transfert échoue", async () => {
    const vus: string[] = []
    const r = await joue(plan(), serveur(() => ok(), vus), false, transfertEchoue)

    expect(vus).toEqual([])
    expect(r.outcome).toBe("failed")
    expect(r.residue).toEqual([])
    expect(r.transfert?.ok).toBe(false)
  })

  it("dit dans quel répertoire l'arborescence atterrit", () => {
    expect(repertoireDeTravail("boutique")).toBe("/opt/skynode/work/boutique")
    expect(() => repertoireDeTravail("../evasion")).toThrow()
  })
})

/* ----------------------------------------------------------------------- le dryRun --- */

describe("executePlan — dryRun", () => {
  /** L'invariant : `dryRun` n'ouvre aucune session et n'exécute rien. */
  it("n'exécute rien du tout", async () => {
    const run = vi.fn()
    const transfer = vi.fn(transfertReussi)
    const r = await executePlan(plan(), { run } as unknown as SshRunner, CIBLE, CTX, {
      dryRun: true,
      transfer,
    })

    expect(run).not.toHaveBeenCalled()
    expect(transfer).not.toHaveBeenCalled()
    expect(r.dryRun).toBe(true)
    expect(r.steps).toHaveLength(plan().etapes.length)
    expect(r.outcome).toBe("unchanged")
  })

  /** Il compose quand même les scripts : un plan que les recettes refusent doit se voir ici. */
  it("refuse en simulation un plan qu'aucune recette ne peut composer", async () => {
    const mauvais = plan()
    mauvais.application = "Boutique"
    const run = vi.fn()
    const r = await executePlan(mauvais, { run } as unknown as SshRunner, CIBLE, CTX, { dryRun: true })

    expect(run).not.toHaveBeenCalled()
    expect(r.outcome).toBe("failed")
  })
})

/* --------------------------------------------------- refus avant toute exécution --- */

describe("executePlan — le refus avant d'agir", () => {
  /**
   * Une recette qui refuse une valeur doit le faire **avant** la première étape. Découvrir
   * à l'étape 7 que l'étape 7 ne se compose pas laisserait six étapes appliquées pour une
   * faute que rien n'obligeait à découvrir si tard.
   */
  it("n'exécute rien quand une étape tardive ne se compose pas", async () => {
    const vus: string[] = []
    const mauvais = plan([
      { type: "proxy.caddy.install" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "app.run", port_interne: 3000, reseau: "host" },
    ])
    const r = await joue(mauvais, serveur(() => ok(), vus))

    expect(vus).toEqual([])
    expect(r.outcome).toBe("failed")
    expect(r.steps[0]?.detail).toMatch(/réseau/)
    expect(r.residue).toEqual([])
  })

  /**
   * Le harnais de conformité (`step.ts`) est le dernier filet avant qu'un script s'exécute
   * en root. Une recette qui rendrait un script sans marqueur de fin ferait lire à
   * `runRemote` une session coupée — ou pire, ferait passer pour appliquée une étape dont
   * on ne sait rien. L'exécuteur doit donc refuser **avant** d'ouvrir la moindre session.
   */
  it("refuse un script non conforme sans ouvrir de session", async () => {
    const vus: string[] = []
    const recette: StepRecipe = {
      script: () => "echo bonjour",
      undoScript: () => null,
    }
    const r = await executePlan(plan(), serveur(() => ok(), vus), CIBLE, CTX, {
      dryRun: false,
      transfer: transfertReussi,
      recipes: () => recette,
    })

    expect(vus).toEqual([])
    expect(r.outcome).toBe("failed")
    expect(r.steps[0]?.detail).toMatch(/contrôle/)
  })

  /** Le même filet vaut pour le script d'annulation, qui ne joue qu'après un échec. */
  it("refuse une annulation non conforme sans ouvrir de session", async () => {
    const vus: string[] = []
    const recette: StepRecipe = {
      script: () => "printf 'step.outcome\tunchanged\n'; printf 'step.end\t1\n'",
      undoScript: () => "[[ -f /x ]]",
    }
    const r = await executePlan(plan(), serveur(() => ok(), vus), CIBLE, CTX, {
      dryRun: false,
      transfer: transfertReussi,
      recipes: () => recette,
    })

    expect(vus).toEqual([])
    expect(r.outcome).toBe("failed")
    expect(r.steps[0]?.detail).toMatch(/annulation/)
  })

  /** Un fichier d'environnement hors du dépôt se refuse aussi avant toute session. */
  it("n'exécute rien quand un fichier d'environnement sort de la racine", async () => {
    const vus: string[] = []
    const mauvais = plan([
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "env.write", depuis: "../ailleurs.env" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
    ])
    const r = await joue(mauvais, serveur(() => ok(), vus))

    expect(vus).toEqual([])
    expect(r.outcome).toBe("failed")
  })
})

/* ------------------------------------------------------------- le retour arrière --- */

describe("executePlan — le retour arrière", () => {
  /**
   * Le cas qui justifie toute la tâche. Un serveur laissé à mi-chemin est le pire résultat
   * possible : ni l'ancien état, ni le nouveau, et un agent qui n'a aucun moyen de savoir
   * où il en est.
   */
  it("défait les étapes précédentes, en ordre inverse", async () => {
    const vus: string[] = []
    const r = await joue(
      plan(),
      serveur((t) => (t === "app.run" ? echec("le conteneur s'est arrêté") : ok()), vus)
    )

    expect(r.outcome).toBe("failed")
    expect(vus.filter((v) => v.startsWith("undo:"))).toEqual([
      "undo:build.image",
      "undo:proxy.caddy.install",
    ])
  })

  /**
   * Une étape qui n'avait rien changé n'a rien à défaire — et la défaire retirerait un
   * Caddy que le client avait posé lui-même avant nous.
   */
  it("ne défait pas une étape restée unchanged", async () => {
    const vus: string[] = []
    await joue(
      plan(),
      serveur((t) => {
        if (t === "app.run") return echec("le conteneur s'est arrêté")
        if (t === "proxy.caddy.install") return rien()
        return ok()
      }, vus)
    )

    expect(vus).toContain("undo:build.image")
    expect(vus).not.toContain("undo:proxy.caddy.install")
  })

  /** L'étape en échec elle-même ne se défait pas : elle n'a rien appliqué à défaire. */
  it("ne tente pas de défaire l'étape qui a échoué", async () => {
    const vus: string[] = []
    const r = await joue(plan(), serveur((t) => (t === "app.run" ? echec("x") : ok()), vus))

    expect(vus).not.toContain("undo:app.run")
    expect(r.steps.find((s) => s.type === "app.run")?.undone).toBeUndefined()
  })

  /**
   * Installer Docker ne se désinstalle pas. Prétendre le contraire serait pire que
   * l'admettre : le développeur doit savoir ce qui reste sur sa machine.
   */
  it("déclare en résidu ce qu'il ne peut pas défaire", async () => {
    const r = await joue(
      planAvecEquipement(),
      serveur((t) => (t === "app.run" ? echec("x") : ok()))
    )

    expect(r.steps.find((s) => s.type === "host.install_docker")?.undone).toBe("impossible")
    expect(r.residue.join(" ")).toMatch(/Docker/)
  })

  /**
   * Le cas le plus délicat : l'annulation elle-même échoue. On ne s'arrête pas — on
   * continue de défaire le reste, et on rapporte les deux.
   */
  it("poursuit l'annulation même si l'une d'elles échoue", async () => {
    const r = await joue(
      plan(),
      serveur((t) => {
        if (t === "app.run") return echec("x")
        if (t === "undo:build.image") return echec("image occupée")
        return ok()
      })
    )

    expect(r.steps.find((s) => s.type === "build.image")?.undone).toBe("failed")
    expect(r.steps.find((s) => s.type === "proxy.caddy.install")?.undone).toBe("done")
    expect(r.residue.join(" ")).toMatch(/image/)
  })

  /** Une annulation qui n'avait rien à défaire a quand même abouti. */
  it("compte une annulation unchanged comme faite", async () => {
    const r = await joue(
      plan(),
      serveur((t) => {
        if (t === "app.run") return echec("x")
        if (t.startsWith("undo:")) return rien()
        return ok()
      })
    )

    expect(r.steps.find((s) => s.type === "build.image")?.undone).toBe("done")
    expect(r.residue).toEqual([])
  })

  /** Une coupure réseau au milieu ne doit pas être prise pour une étape appliquée. */
  it("traite une connexion perdue comme un échec, pas comme un succès", async () => {
    const coupe: SshRunner = {
      run: async () => ({ code: 255, stdout: "", stderr: "Connection closed by remote host" }),
    }
    expect((await joue(plan(), coupe)).outcome).toBe("failed")
  })

  /** Une sortie sans marqueur de fin est une session coupée, jamais une étape aboutie. */
  it("traite une sortie tronquée comme un échec", async () => {
    const tronque: SshRunner = {
      run: async () => ({ code: 0, stdout: "step.outcome\tapplied\n", stderr: "" }),
    }
    expect((await joue(plan(), tronque)).outcome).toBe("failed")
  })

  it("s'arrête à la première étape en échec, sans exécuter les suivantes", async () => {
    const vus: string[] = []
    await joue(plan(), serveur((t) => (t === "build.image" ? echec("x") : ok()), vus))

    expect(vus).not.toContain("app.run")
  })
})

/* ------------------------------------------------------------- le durcissement SSH --- */

/**
 * Le durcissement SSH ne peut pas être un script d'étape : son filet exige d'ouvrir de
 * vraies sessions en tant que compte applicatif, avant puis après avoir coupé le mot de
 * passe. La recette de `host.prepare` le déclare par `needsSecondSession` ; c'est
 * l'exécuteur, seul à détenir le `SshRunner`, qui doit l'exécuter.
 *
 * **Ces tests existent parce que le branchement avait été oublié.** Tout était écrit,
 * testé et éprouvé sur banc — et rien ne l'appelait : `ssh-harden.ts` n'était importé par
 * aucun module de production, et aucun test ne s'en apercevait.
 */
describe("executePlan — le durcissement SSH", () => {
  const planAvecPreparation = (): Plan =>
    plan([
      { type: "host.prepare", swap_mo: 2048 },
      { type: "proxy.caddy.install" },
    ])

  it("durcit SSH après l'étape qui le réclame", async () => {
    const harden = vi.fn(durcissementReussi)
    const r = await joue(planAvecPreparation(), serveur(() => ok()), false, transfertReussi, harden)

    expect(harden).toHaveBeenCalledTimes(1)
    expect(harden.mock.calls[0]?.[1]).toEqual(CIBLE)
    // Le compte visé est l'applicatif, celui que `host.prepare` vient de doter d'une clé.
    expect(harden.mock.calls[0]?.[2]).toBe("skynode")
    expect(r.steps.find((s) => s.type === "host.prepare")?.durcissement?.outcome).toBe("applied")
  })

  /** Aucune autre étape ne l'ouvre : un durcissement de trop couperait des sessions pour rien. */
  it("ne durcit pas quand aucune étape ne le réclame", async () => {
    const harden = vi.fn(durcissementReussi)
    await joue(plan(), serveur(() => ok()), false, transfertReussi, harden)

    expect(harden).not.toHaveBeenCalled()
  })

  /**
   * Une machine déjà préparée peut n'avoir jamais été durcie, parce qu'un passage précédent
   * s'est arrêté à cette étape même. `hardenSsh` est idempotent : le rejouer ferme ce trou.
   */
  it("durcit aussi quand l'étape était déjà appliquée", async () => {
    const harden = vi.fn(durcissementReussi)
    await joue(
      planAvecPreparation(),
      serveur((t) => (t === "inconnu" ? rien() : ok())),
      false,
      transfertReussi,
      harden
    )

    expect(harden).toHaveBeenCalledTimes(1)
  })

  /**
   * Poursuivre après un durcissement en échec livrerait une application sur un serveur dont
   * on sait qu'on n'a pas su fermer la porte — la promesse faite au client, précisément.
   */
  it("arrête le plan quand le durcissement échoue", async () => {
    const vus: string[] = []
    const harden: HardenFn = async () => ({
      outcome: "failed",
      detail: "La porte du compte applicatif ne s'est pas ouverte : rien n'a été durci.",
      diagnostic: "",
    })
    const r = await joue(planAvecPreparation(), serveur(() => ok(), vus), false, transfertReussi, harden)

    expect(r.outcome).toBe("failed")
    expect(vus).not.toContain("proxy.caddy.install")
    expect(r.steps.find((s) => s.type === "host.prepare")?.durcissement?.outcome).toBe("failed")
  })

  /**
   * `host.prepare` est irréversible : un durcissement raté laisse donc une machine préparée,
   * et le rapport doit le nommer plutôt que de laisser croire à un retour arrière complet.
   */
  it("déclare en résidu la préparation qu'un durcissement raté ne défait pas", async () => {
    const harden: HardenFn = async () => ({ outcome: "failed", detail: "refusé", diagnostic: "" })
    const r = await joue(planAvecPreparation(), serveur(() => ok()), false, transfertReussi, harden)

    expect(r.steps.find((s) => s.type === "host.prepare")?.undone).toBe("impossible")
    expect(r.residue.join(" ")).toMatch(/préparer la machine/)
  })

  /** En simulation, rien ne s'ouvre — le durcissement pas davantage que les étapes. */
  it("ne durcit rien en simulation", async () => {
    const harden = vi.fn(durcissementReussi)
    await joue(planAvecPreparation(), serveur(() => ok()), true, transfertReussi, harden)

    expect(harden).not.toHaveBeenCalled()
  })
})
