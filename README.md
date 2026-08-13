# Bot WhatsApp Quizz

Bot Node.js/TypeScript animant un quizz de culture générale dans un
groupe WhatsApp : inscription, 6 phases × 10 questions QCM, scoring
avec bonus de rapidité et sans-faute, classements SQLite.

## Stack

- **Baileys** (`@whiskeysockets/baileys`) pour la connexion WhatsApp
  (WebSocket natif, plus léger et stable que whatsapp-web.js pour une
  session longue avec des timers serrés — voir justification donnée
  en amont)
- **better-sqlite3** pour l'état de partie, les scores et l'historique
  des réponses (synchrone, adapté aux écritures fréquentes pendant les
  timers de 15s)
- **TypeScript** strict

## 1. Installation

```bash
npm install
```

## 2. Configuration

```bash
cp .env.example .env
```

Générez une session_id
```bash
npm run generate-session
```

Copier la session-id dans les variables d'environnement

Éditez `.env` si besoin :

```
QUIZZ_ACCESS_MODE=linkedAccount   # ou "everyone"
AUTH_FOLDER=./auth_info
DB_PATH=./data/quiz.db
DISCONNECT_CANCEL_TIMEOUT_MS=15000
MEGA_EMAIL=youremailmega@gmail.com
MEGA_PASSWORD=yourpasswordmega
SESSION_ID=SESSIONID
```

`QUIZZ_ACCESS_MODE` contrôle qui peut lancer `.quizz` :

- **`linkedAccount`** (défaut) : seul le compte WhatsApp lié au bot
  (celui qui a scanné le QR code) peut lancer une partie. Détecté via
  le flag `fromMe` que Baileys calcule lui-même en interne — aucun
  numéro à configurer, et ça fonctionne quel que soit le format de JID
  utilisé par WhatsApp (`@s.whatsapp.net` ou `@lid`).
- **`everyone`** : n'importe qui dans le groupe peut lancer `.quizz`.

## 3. Questions

Le jeu a besoin d'**au moins 1 fichier de thème** valide dans
`src/questions/data/themes/` pour démarrer. Sans argument, `.quizz`
utilise `Math.min(config.phaseCount, nombre de thèmes disponibles)`
phases — donc ça fonctionne même avec un seul thème pour tester
rapidement. Ajoutez plus de fichiers pour plus de variété : **à chaque
partie, les thèmes sont tirés au sort** parmi tous ceux disponibles
(sans répétition dans une même partie), et vous pouvez demander un
nombre de phases précis avec `.quizz <nombre>` (dans la limite du
nombre de thèmes chargés).

Chaque fichier doit contenir **au moins 10 questions**
(`config.questionsPerPhase`) — vous pouvez en mettre plus : **10
questions sont tirées au sort** dans le thème à chaque partie, dans un
ordre mélangé. Un thème avec 30 questions offre donc de la variété
d'une partie à l'autre sans jamais répéter deux fois la même question
dans une même phase.

Un seul thème d'exemple est fourni (`histoire.json`, 10 questions) pour
valider la structure. **Pour lancer une vraie partie multi-phases**,
ajoutez d'autres fichiers JSON sur le même modèle (`geographie.json`,
`sciences.json`, `cinema.json`, `sport.json`, `musique.json`, etc.).

Format attendu d'un fichier de thème :

```json
{
  "theme": "Nom du thème",
  "questions": [
    {
      "question": "Énoncé de la question ?",
      "choices": ["Proposition 1", "Proposition 2", "Proposition 3", "Proposition 4"],
      "correctIndex": 1
    }
  ]
}
```

`choices` est une **liste simple de 4 propositions**, dans l'ordre que
vous voulez — pas de lettre A/B/C/D figée dans le fichier.
`correctIndex` indique la position (0 à 3) de la bonne réponse dans
cette liste. C'est volontaire : à chaque partie, le bot mélange
lui-même l'ordre des 4 propositions avant de les afficher (donc leur
lettre A/B/C/D change d'une partie à l'autre, même pour une question
identique) — voir `questionLoader.pickQuestionsForPhase`. Vous n'avez
donc jamais à mélanger l'ordre vous-même dans le fichier.

> **Ancien format (avant cette version)** : si vous avez des fichiers
> écrits avec `"choices": { "A": ..., "B": ... }` et `"answer": "B"`,
> il faut les convertir vers le nouveau format ci-dessus — la lettre
> `"B"` devient `"correctIndex": 1` (A=0, B=1, C=2, D=3) et les valeurs
> de `choices` deviennent une liste dans l'ordre A, B, C, D.

Le chargeur (`questionLoader.ts`) valide strictement ce format au
démarrage et refuse de lancer une partie si un fichier est corrompu ou
si aucun thème valide (avec au moins 10 questions chacun) n'est
présent — vous aurez un message d'erreur explicite en console plutôt
qu'un plantage en pleine partie.

## 4. Lancement

**Développement** (TypeScript direct, rechargement manuel) :

```bash
npm run dev
```

**Production** (compilation puis exécution) :

```bash
npm run build
npm start
```

## 5. Authentification WhatsApp

Au premier lancement, un QR code s'affiche dans le terminal. Scannez-le
depuis l'application WhatsApp du numéro qui fera tourner le bot :
**Paramètres → Appareils liés → Lier un appareil**.

La session est ensuite persistée dans le dossier `AUTH_FOLDER`
(`./auth_info` par défaut) : les lancements suivants ne redemandent
pas de QR code, sauf si vous vous déconnectez manuellement depuis
WhatsApp (auquel cas supprimez ce dossier et rescannez).

## 6. Utilisation dans un groupe

- `.quizz` — lance une partie avec le nombre de phases par défaut
  (`config.phaseCount`, 6 par défaut, plafonné au nombre de thèmes
  disponibles). Accès selon `QUIZZ_ACCESS_MODE`.
- `.quizz <nombre>` — lance une partie avec un nombre de phases
  personnalisé (ex : `.quizz 3`), dans la limite du nombre de thèmes
  chargés.
- `.quizz stop` — arrête immédiatement la partie en cours dans le
  groupe (même contrôle d'accès que `.quizz`).
- `.quizz rules` — affiche les règles complètes, accessible à tous.
- `Partant` — à taper par les joueurs pendant la fenêtre d'inscription
  (insensible à la casse).
- Pendant une question : répondre avec `A`, `B`, `C` ou `D`. Le bot
  reconnaît aussi des réponses formulées en phrase (voir ci-dessous).

### Reconnaissance des réponses dans un vrai groupe qui discute

Le groupe continue de vivre normalement pendant le quizz (blagues,
réponses à d'autres messages, etc.), donc le bot est volontairement
sélectif sur ce qu'il traite comme une réponse (`utils/answerParser.ts`) :

- **Reconnu directement** : le message est juste la lettre, avec de la
  ponctuation usuelle autour — `A`, `a`, `A.`, `(B)`, `c)`, `D !`.
- **Reconnu en phrase**, via un mot-clé de réponse explicite —
  `réponse B`, `je dis C`, `c'est A`, `choix D`, `option B`.
- **Volontairement ignoré** : une lettre isolée au milieu d'une phrase
  sans mot-clé (ex : *"je crois que a va gagner"*). En français, "a" est
  un mot très courant (verbe avoir) — le reconnaître comme réponse à
  chaque occurrence créerait beaucoup plus de faux positifs que
  d'aide. Le motif le plus fiable reste la lettre seule ou un des
  mots-clés ci-dessus.

Si vous voulez élargir ou modifier ces règles (autres mots-clés,
langue différente...), tout est centralisé dans
`extractAnswerChoice()` (`utils/answerParser.ts`).

## 7. Déroulement d'une partie (ce que les joueurs voient)

1. **Inscription (60s)** : annonce initiale, puis un rappel stylisé
   toutes les 10s (nombre d'inscrits, temps restant, message
   d'encouragement aléatoire).
2. **Rappel des règles** : message convivial juste avant le début,
   suivi d'une pause de lecture (~9s) avant de démarrer.
3. **Annonce de phase** : thème affiché, pause de lecture (~5s) avant
   la première question.
4. **Par question** : énoncé → message de décompte qui s'édite en
   temps réel (⏳ 15s → ... → 🛑 STOP) → réaction ✅/❌ instantanée sur
   le message de chaque joueur dès qu'il répond → annonce des points
   gagnés avec mention directe des joueurs (`+2 pour @Jean ⚡ bonus de
   rapidité +1`) → `➡️ Question suivante...` avant d'enchaîner.
5. **Fin de phase** : classement intermédiaire (joueurs mentionnés),
   bonus sans-faute, pause de lecture (~6s) avant la suite.
5. **Fin de partie** : classement final, gagnant (ou co-gagnants)
   mentionné(s).

**Bonus "majorité ratée"** : si 90%+ des joueurs inscrits ratent une
question (mauvaise réponse ou pas de réponse), ceux qui trouvent la
bonne réponse touchent +4 points au lieu de +2 pour cette question
(configurable via `config.majorityMissThreshold` et
`config.points.majorityMissBonus`).

Tous les délais de lecture (rappel des règles, annonce de thème,
classement de phase, pause post-révélation...) sont centralisés dans
`src/config/config.ts` (`*PauseMs`, `*Ms`) si vous voulez les
raccourcir ou les allonger.

## 8. Robustesse et performance à grande échelle

Pensé pour rester fluide même avec beaucoup de joueurs inscrits :

- **Traitement concurrent des messages entrants** (`bot/connection.ts`) :
  un lot de messages WhatsApp reçu en même temps (ex : 30 joueurs qui
  répondent à la même seconde) est traité en parallèle, pas un par un.
  Ça ne crée aucun risque de double-comptage : le marquage "ce joueur a
  déjà répondu" se fait de façon synchrone en mémoire (`Set`) avant tout
  accès réseau ou base de données.
- **Limitation de débit vers WhatsApp** (`utils/semaphore.ts`) : tous
  les envois, éditions et réactions passent par un sémaphore partagé
  (`config.maxConcurrentWhatsAppCalls`, 6 par défaut). Ça évite
  d'envoyer une rafale de dizaines d'appels simultanés à la connexion
  Baileys, ce qui est une cause plausible d'instabilité de session
  (renégociations de clés, messages perdus) — augmentez cette valeur
  prudemment si vous testez avec un très grand groupe et une connexion
  stable, ou baissez-la si vous observez des soucis de session.
- **SQLite synchrone** (`better-sqlite3`) pour les écritures de score :
  pas d'overhead de promesses/event-loop sur le chemin critique d'une
  réponse de joueur.
- **Décompte à coût constant** : le décompte affiché s'appuie sur
  l'édition d'un seul message par question, jamais un message par
  joueur — le coût ne grandit pas avec le nombre de participants.

## 9. Comportement en cas de coupure de connexion

Décision produit retenue : **annulation propre**, pas de reprise. Si le
bot perd la connexion WhatsApp pendant une partie en cours, celle-ci
est marquée `cancelled` en base et le groupe reçoit un message
l'informant que la partie a été annulée. Le bot se reconnecte ensuite
automatiquement (sauf déconnexion manuelle/logout) et accepte de
nouvelles commandes `.quizz`. `.quizz stop` suit exactement le même
mécanisme d'arrêt propre, déclenché manuellement.

## 10. Base de données

Le fichier SQLite (`DB_PATH`) est créé automatiquement au premier
lancement, avec le schéma suivant :

- `games` — une ligne par partie (statut, nombre de phases demandé,
  phase/question courante). Un index unique garantit qu'une seule
  partie `registration`/`running` peut exister par groupe à la fois.
- `players` — joueurs inscrits par partie.
- `answers` — chaque réponse valide, avec contrainte d'unicité
  `(game_id, player_id, phase, question_index)` : c'est ce qui garantit
  nativement que seule la première réponse d'un joueur à une question
  compte, même en cas de double envoi quasi simultané. La colonne
  `message_key` conserve une référence au message WhatsApp d'origine
  (utilisée pour la réaction ✅/❌).
- `phase_bonuses` — bonus sans-faute par phase.

Les classements (`getScoreboard`) sont calculés par requête SQL à la
volée, pas maintenus en cache — simple et toujours cohérent.

> **Mise à jour depuis une version antérieure** : si vous aviez déjà
> une base `DB_PATH` créée par une ancienne version du bot, les
> nouvelles colonnes (`phase_count`, `message_key`) sont ajoutées
> automatiquement au démarrage (migration légère dans `database.ts`) —
> aucune action manuelle requise.

## 11. Extensibilité

- **Barème / durées** : tout est dans `src/config/config.ts`, rien en
  dur dans la logique de jeu.
- **Nouveaux thèmes** : ajoutez un fichier JSON dans
  `src/questions/data/themes/`, aucune modification de code requise.
- **Textes du bot** : centralisés dans `src/messages/templates.ts`.
