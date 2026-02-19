# LoL Companion — Stream Deck Plugin

A comprehensive League of Legends companion plugin for Elgato Stream Deck and Stream Deck+.

**Version:** 1.2.4  
**Author:** Desstroct  
**License:** Proprietary

## Features (15 Actions)

### Lobby & Queue

| Action | Description | Stream Deck+ |
| -------- | ------------- | -------------- |
| **Game Status** | Shows LoL client state (Lobby, Queue, ChampSelect, InGame) | Key |
| **LP Tracker** | Current rank, LP, win rate, session gains | Dial: Solo/Flex/TFT |
| **Auto Accept** | Automatically accept match ready check | Key toggle |

### Champion Select

| Action | Description | Stream Deck+ |
| -------- | ------------- | -------------- |
| **Lobby Scanner** | Player info (champion, rank, win rate) | Dial: cycle players |
| **Lobby Level** | Average summoner level in lobby | Key |
| **Smart Pick** | Counter picks + Best picks combined (auto-detect role) | Dial: scroll/toggle |
| **Auto Rune** | Auto-import optimal runes + summoner spells from Lolalytics | Dial: WR/Popular |
| **Skill Order** | Recommended skill max order (Q > E > W) with level-by-level grid | Dial: Common/WR |
| **Auto Pick/Ban** | Automatically pick and ban your configured champions | Key toggle |

### In-Game

| Action | Description | Stream Deck+ |
| -------- | ------------- | -------------- |
| **KDA Tracker** | Live KDA, CS/min, gold | Dial: dashboard |
| **Best Item** | Next recommended item with gold progress | Dial: browse build |
| **Death Timer** | Respawn countdown + level | Dial |
| **Jungle Path** | Recommended jungle clear path for your champion | Dial: scroll camps |
| **Recall Window** | Shows when to recall based on gold and item breakpoints | Dial: adjust target |

### Session Tracking

| Action | Description | Stream Deck+ |
| -------- | ------------- | -------------- |
| **Session Stats** | Wins, losses, LP delta, and streaks for your session | Dial: switch queue |

## Supported Game Modes

| Mode | Support |
| ------ | --------- |
| **Ranked Solo/Duo** | ✅ Full |
| **Ranked Flex** | ✅ Full |
| **Draft Pick** | ✅ Full |
| **Blind Pick** | ⚠️ Partial (no assigned positions) |
| **ARAM** | ⚠️ In-game stats only |
| **TFT** | ⚠️ LP Tracker only |

## Installation

1. Download the latest release from [Releases](../../releases)
2. Double-click the `.streamDeckPlugin` file
3. Stream Deck software will install the plugin automatically

## Requirements

- Elgato Stream Deck software v6.0+
- League of Legends client installed
- Windows 10/11 or macOS 12+

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

## Support

If this plugin helps you climb, consider supporting development:

[![PayPal](https://img.shields.io/badge/PayPal-Donate-blue?logo=paypal)](https://paypal.me/Desstroct)

## License

Proprietary — See [LICENSE](LICENSE) for details.
