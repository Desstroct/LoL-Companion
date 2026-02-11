# LoL Companion — Stream Deck Plugin

A comprehensive League of Legends companion plugin for Elgato Stream Deck and Stream Deck+.

**Version:** 1.1.0  
**Author:** Desstroct  
**License:** MIT

## Features

### Champion Select (20 actions)

| Action | Description | Stream Deck+ |
|--------|-------------|--------------|
| **Game Status** | Shows LoL client state (Lobby, Queue, ChampSelect, InGame) | Key |
| **Lobby Scanner** | Player info (champion, rank, win rate) | Dial: cycle players |
| **Counterpick** | Counter suggestions vs lane opponent | Dial: scroll counters |
| **Best Pick** | Best overall pick considering enemies + ally synergy | Dial: scroll picks |
| **Team Comp** | Composition analysis (AD/AP split, roles, strengths/weaknesses) | Dial: ally/enemy |
| **Dodge Advisor** | Teammate analysis (WR, games on champ, autofill, streaks) | Dial: cycle players |
| **Auto Pick/Ban** | Automatically pick and ban your configured champions | Key toggle |
| **Auto Rune** | Auto-import optimal runes from Lolalytics | Dial: WR/Popular |
| **Lobby Level** | Average summoner level in lobby | Key |
| **LP Tracker** | Current rank, LP, session gains | Dial: Solo/Flex |

### In-Game

| Action | Description | Stream Deck+ |
|--------|-------------|--------------|
| **KDA Tracker** | Live KDA, CS/min, gold | Dial: dashboard |
| **Summoner Tracker** | Enemy summoner spell cooldowns | Dial: cycle enemies |
| **Jungle Timer** | Dragon, Voidgrubs, Herald, Baron timers | Dial: cycle objectives |
| **Best Item** | Next recommended item with gold progress | Dial: browse build |
| **Death Timer** | Respawn countdown + level | Dial |
| **Enemy Builds** | Enemy items in real-time | Dial: cycle enemies |
| **Power Spike** | Alerts for enemy level 6/11/16 + major items | Dial: scroll events |

### Automation

| Action | Description |
|--------|-------------|
| **Auto Accept** | Automatically accept match ready check |
| **Auto Pick/Ban** | Pick and ban champions automatically |
| **Profile Switch** | Quick profile switching |

## Installation

1. Download the latest release from [Releases](../../releases)
2. Double-click the `.streamDeckPlugin` file
3. Stream Deck software will install the plugin automatically

## Requirements

- Elgato Stream Deck software v6.0+
- League of Legends client installed
- Windows 10/11

## Data Sources

- **LCU API** — League Client local API (champion select, runes, ranked stats)
- **Live Client API** — In-game data (127.0.0.1:2999)
- **Lolalytics** — Counter picks, runes, item builds
- **Data Dragon** — Champion/item icons and data

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode (auto-rebuild + restart Stream Deck)
npm run watch
```

## Vanguard Compliance

This plugin only uses **official Riot-sanctioned APIs**:
- ✅ LCU API (League Client)
- ✅ Live Client Data API (in-game, 127.0.0.1:2999)
- ✅ Public websites/CDNs (Lolalytics, Data Dragon)

**Never touches:**
- ❌ Game process memory
- ❌ Network packets
- ❌ Game files
- ❌ Input injection

## License

MIT License — See [LICENSE](LICENSE) for details.
