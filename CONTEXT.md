# LoL Stream Deck Plugin — Contexte & Étude de marché

## 1. Vision du projet

Créer un **plugin Stream Deck Elgato** qui regroupe un maximum d'informations utiles **en lobby et en jeu** (in-game) pour League of Legends. L'objectif est de centraliser sur le Stream Deck les données que les joueurs vont normalement chercher sur plusieurs sites/apps, le tout accessible en un coup d'œil ou un appui de touche.

---

## 2. Analyse de l'existant — Apps companion LoL

### 2.1 Blitz.gg
- **Type** : App desktop (standalone)
- **Features principales** :
  - Auto-import des runes et builds
  - Overlay in-game (Gold comparison scoreboard, Item value difference, Minimap timers, Ultimate timers)
  - Suggestions de picks & bans
  - ARAM Health Timers
  - Recommended Skill Order
  - Tier List
  - Arena Augments
  - Post Match Analysis
  - Jungle Pathing Overlay
  - Loading Screen Overlay
  - Trinket Reminder Overlay
  - Pro Builds
  - Champion Statistics
  - Benchmarking overlay (comparaison avec d'autres joueurs)
- **Forces** : Très complet, overlay intégré, auto-import runes fonctionne bien
- **Faiblesses** : Perçu comme "bloatware" par certains joueurs, overlay parfois buggé, UI encombrée

### 2.2 OP.GG
- **Type** : Site web + App desktop + App mobile
- **Features principales** :
  - Recherche de profil joueur (historique depuis S3)
  - Real-time auto rune setting
  - OP champions, team comps recommendations
  - In-game overlay
  - Esports stats & standings
  - Streamer Overlay
  - Pro spectate (live)
  - Leaderboards
  - Skins leaderboard
- **Forces** : Base de données historique massive, très populaire en Corée et mondialement, interface claire
- **Faiblesses** : Overlay signalé comme ne fonctionnant plus par certains joueurs, publicités envahissantes

### 2.3 Porofessor.gg
- **Type** : Site web + App desktop
- **Features principales** :
  - Live game search en temps réel
  - Player analysis (détection des premades, scoring des joueurs)
  - Champion select overlay
  - In-game overlay
  - Copier-coller du chat lobby pour analyser l'équipe
- **Forces** : Détection des premades très appréciée, analyse des joueurs en temps réel, données basées sur League of Graphs
- **Faiblesses** : Pas de champion stats/builds sur le site (uniquement via l'app), manque de profondeur sur les données de builds

### 2.4 U.GG
- **Type** : Site web + App desktop
- **Features principales** :
  - Tier List détaillée par rôle
  - Champion builds & runes
  - Multisearch (rechercher plusieurs joueurs)
  - Leaderboards
  - Live Games (spectate)
  - Probuild Stats
  - News & patch notes
  - ARAM Mayhem tier list
- **Forces** : Interface claire et simple, données fiables, bon pour les débutants
- **Faiblesses** : Très similaire aux autres tools, peu de différenciation

### 2.5 Autres outils mentionnés par la communauté
- **Lolalytics** : Préférée par les Rioters eux-mêmes (Riot Phlox, Riot August). Données les plus proches de celles utilisées par Riot. Analyse approfondie des matchups et win rates.
- **Mobalytics** : Account insights visuellement attrayants, souvent buggé selon les retours
- **DeepLoL** : Outil plus récent pour les stats/builds
- **DPM.lol** : Stats de performance (DPM, etc.) pour le fun

---

## 3. Analyse de l'existant — Marketplace Elgato (Stream Deck)

### 3.1 Plugins LoL existants

| Plugin | Auteur | Prix | Description |
|--------|--------|------|-------------|
| **LeagueDeck** | TimeBlaster | Gratuit | Spell Timer (suivi des summoners ennemis avec chat auto), Buy Item tracker (affiche le coût restant d'un item). Écrit en C#. Dernière mise à jour : 2021 (abandonné). 14 stars GitHub. |
| **DeckLegends** | HZ Industries | 1,99€ | Auto-Accept, Auto-Pick, Auto-Ban, Auto-Summoners, Auto-Runes (custom), Live-Image (champion + alertes Dragon/Baron), Live CS/min, Live-Rank, Status-Action, Scout Ready (raccourci OP.GG). Futur : Player Scout, Jungle Timers. |
| **League of Legends Login** | Nick Pirocanac | Gratuit | Login multi-comptes rapide. Termine les processus Riot entre les connexions. |
| **League Observer Tool** | RCVolus | Gratuit | Contrôle de l'outil d'observation League via Stream Deck (usage caster/spectateur). |

### 3.2 Overlays & Designs LoL sur le marketplace
- **Royal LoL In-Game Overlay** (Elgato, gratuit) — Overlays stream inspirés LoL
- **Hexrift** (GETREKT, 33,83€) — Pack complet overlays stream animés LoL
- **Sun and Moon** (StreamSpell, 25,38€) — Inspiré Eclipse skins
- **Demon Hunter** (StreamSpell, 17,77€) — Inspiré Yone
- **Challenger** (StreamSpell, 17,77€) — Thème compétitif
- **Realm** (Elgato, 12,69€) — Thème MOBA/fantasy

### 3.3 Constats
- **Le marché Stream Deck pour LoL est quasiment vide en plugins fonctionnels**
- LeagueDeck est abandonné depuis 2021
- DeckLegends est le seul concurrent sérieux et actif (v0.6, 1,99€)
- Les overlays/designs sont nombreux mais ne sont que cosmétiques (stream)
- **Aucun plugin ne combine données lobby + in-game + stats de manière complète**

---

## 4. Étude des demandes communautaires (Reddit, forums)

### 4.1 Frustrations récurrentes des joueurs

1. **"Bloatware"** — Les apps desktop (Blitz, Mobalytics) sont perçues comme lourdes, consommant des ressources. Beaucoup de joueurs préfèrent alt-tab vers un site web.
2. **Overlay buggé** — OP.GG overlay ne fonctionne plus pour certains, Blitz overlay parfois instable.
3. **Trop d'informations non pertinentes** — Auto-import runes, suggested level-ups, pop-ups en lobby/game launch... Certains veulent juste les infos essentielles sans le bruit.
4. **Overwolf** — Forte aversion de la communauté envers Overwolf. Les joueurs cherchent activement des alternatives sans Overwolf.
5. **Fragmentation** — Les joueurs utilisent 2-3 outils différents : Lolalytics pour les builds, OP.GG pour l'historique, Porofessor pour l'analyse de lobby, DPM.lol pour les stats fun.
6. **MacOS** — Manque cruel de support Mac (overlay + rune import). Piste intéressante si le plugin supporte Mac.
7. **Minimalisme** — Demande claire pour un outil minimaliste "champion info only" sans player scouting intrusif.

### 4.2 Features les plus demandées/appréciées

| Feature | Source / Contexte |
|---------|-------------------|
| **Gold comparison** (scoreboard in-game) | Blitz — feature favorite de plusieurs joueurs |
| **Détection des premades** | Porofessor — feature unique très appréciée |
| **Matchup win rates détaillés** | Lolalytics — supérieure aux autres pour ça |
| **Pro builds** (pas les builds populaires) | Joueurs préfèrent voir ce que les pros font plutôt que le "popular build" |
| **Stats DPM/performance** personnalisées | DPM.lol — fun et utile pour progresser |
| **Runes situationnelles** (pas juste "highest WR") | Demande de builds adaptatifs selon le matchup |
| **Jungle timers** | DeckLegends en roadmap, LeagueDeck n'a jamais implémenté |
| **Player scout** (stats adversaires en lobby) | DeckLegends en roadmap |
| **Tracker de summoners ennemis** | LeagueDeck — core feature, très appréciée par les utilisateurs Stream Deck |
| **CS/min live** | DeckLegends v0.6 — récemment ajouté |
| **Données back-to-back** (historique des confrontations) | Non disponible nulle part actuellement |

---

## 5. Opportunités — Ce que nous pouvons apporter

### 5.1 Concept central : "LoL HUD sur Stream Deck"

Transformer le Stream Deck en **tableau de bord tactique** qui complète l'écran de jeu sans overlay intrusif. Le joueur garde un écran de jeu propre et a toutes les informations sur son Stream Deck.

### 5.2 Features proposées par phase

#### Phase 1 — Lobby Intelligence (Champion Select)
- **Lobby Scanner** : Détection automatique de la game en champion select via l'API LCU (League Client Update)
- **Player Cards** : Affichage sur chaque touche du Stream Deck d'un résumé de chaque joueur (rang, win rate, champion pool, séries de victoires/défaites)
- **Premade Detection** : Identification visuelle des groupes premade (couleur de fond)
- **Matchup Advisor** : Affichage du win rate de votre champion vs les champions ennemis
- **Auto-Runes** : Import de runes en un appui, avec options par matchup (pas juste "highest WR global")

#### Phase 2 — In-Game Tactical HUD
- **Summoner Spell Tracker** : Timer visuel des summoners ennemis (Flash, TP, Ignite...) avec cooldown live sur les touches
- **Jungle Timer** : Dragon, Baron, Rift Herald, Camps ennemis — affichage des timers + type de dragon à venir
- **Gold Tracker** : Différence de gold entre vous et votre lane opponent
- **CS/min Live** : Suivi en temps réel de votre CS/min avec indicateur visuel (vert/jaune/rouge selon le benchmark)
- **Item Build Path** : Affichage de votre build recommandé avec indication du gold manquant pour le prochain item
- **Objective Alerts** : Alertes visuelles/sonores quand Dragon/Baron est bientôt up

#### Phase 3 — Post-Game & Stats
- **Post-Game Summary** : Résumé instantané sur le Stream Deck (KDA, vision score, damage dealt, etc.)
- **Performance Trends** : Graphique de votre win rate sur les dernières sessions
- **Match History Quick View** : Dernières parties avec résultats sur les touches

#### Phase 4 — Innovations & Différenciation
- **Confrontation History** : "Vous avez déjà joué contre ce joueur il y a 3 jours, il était 2/8 en Yasuo"
- **Team Comp Analyzer** : Analyse de la composition d'équipe (manque de tank ? trop d'AP ? pas de CC ?)
- **Danger Zone Alerts** : Basé sur la phase de jeu, rappels contextuels ("Ward dragon pit", "Enemy jungler likely topside")
- **Streamer Mode** : Masquer les noms en lobby pour les streamers, afficher les stats sans révéler les noms
- **Multi-profil** : Profils pour différents champions/rôles qui changent automatiquement le layout du Stream Deck

### 5.3 Avantages compétitifs vs l'existant

| Notre approche | vs Existant |
|----------------|-------------|
| **Pas d'overlay** — info sur le Stream Deck = écran de jeu propre | Blitz/OP.GG/Porofessor ajoutent des overlays parfois intrusifs |
| **Pas de bloatware** — plugin léger, pas d'app desktop lourde | Blitz/Mobalytics sont perçus comme "bloatware" |
| **Pas d'Overwolf** — indépendant | Certains outils dépendent d'Overwolf (très mal vu) |
| **Tactile & physique** — appuyer sur un bouton pour tracker un summoner est plus rapide que de cliquer dans un overlay | Les overlays nécessitent un alt-tab ou un clic in-game |
| **Modulaire** — le joueur choisit exactement les infos qu'il veut voir | Les apps existantes imposent beaucoup de features non désirées |
| **All-in-one Stream Deck** — remplacement de 3-4 outils en un seul plugin | Actuellement les joueurs fragmentent entre Lolalytics + OP.GG + Porofessor |

---

## 6. Stack technique prévu

- **Platform** : Plugin Elgato Stream Deck (SDK v2)
- **Language** : TypeScript / Node.js
- **APIs utilisées** :
  - **Riot LCU API** (League Client Update) — données lobby, champion select, runes
  - **Riot Game Client API** (localhost:2999) — données in-game live
  - **Riot API (Developer)** — historique, stats, ranked info
  - **Data Dragon / CommunityDragon** — assets (images champions, items, spells)
- **Architecture** : Plugin léger, polling optimisé, cache intelligent des assets

---

## 7. Cible utilisateur

- Joueurs ranked LoL (Gold+) qui veulent un avantage informationnel
- Streamers LoL qui veulent un setup propre sans overlay intrusif
- Possesseurs de Stream Deck cherchant à exploiter leur matériel en gaming
- Joueurs frustrés par le bloatware des apps companion existantes

---

## 8. Modèle économique potentiel

- **Gratuit** : Features essentielles (Summoner tracker, lobby info basique, CS live)
- **Premium (2-5€)** : Features avancées (Player Scout complet, Confrontation History, Team Comp Analyzer, Multi-profil)
- **Alternative** : Tout gratuit, financement par donations/sponsors

---

*Document créé le 7 février 2026 — À mettre à jour au fur et à mesure du développement.*
