# Stream Deck SDK Reference (Node.js / TypeScript)

> Comprehensive developer reference for `@elgato/streamdeck` SDK v2.  
> Source: [Elgato Stream Deck SDK docs](https://docs.elgato.com/streamdeck/sdk)  
> Last updated: 2026-05-23

---

## Table of Contents

1. [Plugin Architecture](#1-plugin-architecture)
2. [Project Setup & Build](#2-project-setup--build)
3. [Manifest (manifest.json)](#3-manifest-manifestjson)
4. [Actions](#4-actions)
5. [Action Lifecycle Events](#5-action-lifecycle-events)
6. [Keys (Keypad)](#6-keys-keypad)
7. [Dials & Touch Strip (Encoder)](#7-dials--touch-strip-encoder)
8. [Layouts (Touch Strip)](#8-layouts-touch-strip)
9. [Images & Icons](#9-images--icons)
10. [Settings](#10-settings)
11. [Property Inspectors (UI)](#11-property-inspectors-ui)
12. [Profiles](#12-profiles)
13. [Deep Linking](#13-deep-linking)
14. [Devices](#14-devices)
15. [System Events](#15-system-events)
16. [Application Monitoring](#16-application-monitoring)
17. [Embedded Resources](#17-embedded-resources)
18. [Logging & Debugging](#18-logging--debugging)
19. [Localization (i18n)](#19-localization-i18n)
20. [WebSocket API Reference](#20-websocket-api-reference)
21. [Distribution & Packaging](#21-distribution--packaging)
22. [SDK v2 Breaking Changes](#22-sdk-v2-breaking-changes)
23. [Best Practices](#23-best-practices)

---

## 1. Plugin Architecture

### Two-Layer Architecture

Stream Deck plugins use a two-layer JavaScript architecture:

| Layer | Runtime | Purpose |
|---|---|---|
| **Backend** (Application Layer) | Node.js | Core plugin logic, event handling, WebSocket communication |
| **Frontend** (Presentation Layer) | Chromium | Property inspector HTML UI for user configuration |

### Runtime Versions

| Stream Deck | Node.js | Chromium |
|---|---|---|
| 7.3 | 20.20.0 / 24.13.1 | 130.0.0.0 |
| 7.1-7.2 | 20.20.0 / 24.13.1 | 130.0.0.0 |
| 7.0 | 20.19.0 | 122.0.6261.171 |

From Stream Deck 7.1, Node.js versions are automatically updated to the latest versions supported by Stream Deck.

### Plugin Lifecycle

Stream Deck manages the plugin lifecycle automatically. It provides automatic failure recovery if an unexpected error occurs. The plugin process starts when Stream Deck launches and stops when it shuts down.

### UUID Format

All identifiers (plugin UUID, action UUIDs) use **reverse-DNS notation**:

- Allowed characters: lowercase alphanumeric (`a-z`, `0-9`), hyphens (`-`), periods (`.`)
- Example: `com.elgato.hello-world`
- Action UUIDs are prefixed with the plugin UUID: `com.elgato.hello-world.increment`
- **UUIDs are immutable after Marketplace publication** -- changing them removes actions from user configurations.

---

## 2. Project Setup & Build

### Prerequisites

- **Node.js** 24+ (install via [nvm-windows](https://github.com/coreybutler/nvm-windows))
- **Stream Deck** 7.1+
- Stream Deck device (or Stream Deck Mobile)

### CLI Installation

```bash
npm install -g @elgato/cli
```

### Create a New Plugin

```bash
streamdeck create
```

### Generated Directory Structure

```
.
├── *.sdPlugin/
│   ├── bin/             # Transpiled output
│   ├── imgs/            # Plugin image assets
│   ├── logs/            # Logger output files
│   ├── ui/              # Property inspector HTML
│   │   └── my-action.html
│   └── manifest.json    # Plugin metadata
├── src/
│   ├── actions/
│   │   └── my-action.ts
│   └── plugin.ts        # Entry point
├── package.json
├── rollup.config.mjs
└── tsconfig.json
```

### NPM Scripts

```json
{
  "scripts": {
    "build": "rollup -c",
    "watch": "rollup -c -w --watch.onEnd=\"streamdeck restart com.your.plugin.uuid\""
  }
}
```

### Development Workflow

```bash
npm run watch    # Auto-rebuild + restart on changes
npm run build    # One-shot build
```

---

## 3. Manifest (manifest.json)

JSON schema: `https://schemas.elgato.com/streamdeck/plugins/manifest.json`

### Root-Level Required Fields

| Field | Type | Description |
|---|---|---|
| `Actions` | `Action[]` | Array of action definitions |
| `Author` | `string` | Author name (Marketplace display) |
| `CodePath` | `string` | Path to entry point (e.g. `bin/plugin.js`) |
| `Description` | `string` | Plugin description |
| `Icon` | `string` | Plugin icon path (**extension omitted**) |
| `Name` | `string` | Plugin display name |
| `OS` | `OS[]` | Supported operating systems |
| `SDKVersion` | `integer` | `2` or `3` (3 recommended for DRM) |
| `Software` | `object` | `{ MinimumVersion: string }` -- e.g. `"7.1"` |
| `UUID` | `string` | Unique reverse-DNS identifier |
| `Version` | `string` | Semver + build: `{major}.{minor}.{patch}.{build}` |

### Root-Level Optional Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `ApplicationsToMonitor` | `object` | -- | `{ mac: string[], windows: string[] }` |
| `Category` | `string` | `"Custom"` | Action list grouping |
| `CategoryIcon` | `string` | -- | Icon for category (ext omitted) |
| `CodePathMac` | `string` | -- | macOS-specific entry point |
| `CodePathWin` | `string` | -- | Windows-specific entry point |
| `DefaultWindowSize` | `[w, h]` | `[500, 650]` | Default `window.open()` dimensions |
| `Nodejs` | `object` | -- | Node.js config (see below) |
| `Profiles` | `Profile[]` | -- | Pre-defined profiles |
| `PropertyInspectorPath` | `string` | -- | Global PI HTML path |
| `SupportURL` | `string` | -- | Support link (6.9+) |
| `URL` | `string` | -- | Plugin website |

### Nodejs Object

| Field | Type | Description |
|---|---|---|
| `Version` | `string` | `"20"` or `"24"` (required if `Nodejs` is present) |
| `Debug` | `string` | `"enabled"` (--inspect), `"break"` (--inspect-brk), or custom CLI args |
| `GenerateProfilerOutput` | `boolean` | Generate Node.js profiler output |

Default Node.js launch args: `--no-addons`, `--enable-source-maps`, `--no-global-search-paths`

### Actions Array

Each action object:

#### Required Action Fields

| Field | Type | Description |
|---|---|---|
| `Icon` | `string` | Action icon (ext omitted), 20x20 / 40x40 @2x |
| `Name` | `string` | Display name in actions list |
| `States` | `State[]` | State definitions (max 2 for toggle behavior) |
| `UUID` | `string` | Unique reverse-DNS action identifier |

#### Optional Action Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `Controllers` | `string[]` | -- | `["Keypad"]`, `["Encoder"]`, or both |
| `DisableAutomaticStates` | `boolean` | `false` | Prevent auto state toggle on press |
| `DisableCaching` | `boolean` | `false` | Disable image caching |
| `Encoder` | `object` | -- | Dial/touchscreen config |
| `OS` | `OS[]` | -- | Platform restrictions |
| `PropertyInspectorPath` | `string` | -- | Action-specific PI HTML |
| `SupportedInKeyLogicActions` | `boolean` | `true` | Availability in key logic (7.0+) |
| `SupportedInMultiActions` | `boolean` | `true` | Availability in multi-actions |
| `SupportURL` | `string` | -- | Action-specific support link (6.9+) |
| `Tooltip` | `string` | -- | Hover tooltip |
| `UserTitleEnabled` | `boolean` | `true` | Allow user custom titles |
| `VisibleInActionsList` | `boolean` | `true` | Show in action list |

### States Array

| Field | Type | Description |
|---|---|---|
| `Image` | `string` | State icon (ext omitted), 72x72 / 144x144 @2x. GIF, PNG, SVG |
| `Name` | `string` | State name (shown in multi-actions) |
| `Title` | `string` | Default title text |
| `ShowTitle` | `boolean` | Display title on key |
| `TitleAlignment` | `string` | `"bottom"`, `"middle"`, `"top"` |
| `TitleColor` | `string` | Hex color (e.g. `#FFFFFF`) |
| `FontFamily` | `string` | Default font family |
| `FontSize` | `number` | Default font size |
| `FontStyle` | `string` | `""`, `"Bold"`, `"Italic"`, `"Bold Italic"`, `"Regular"` |
| `FontUnderline` | `boolean` | Underline toggle |
| `MultiActionImage` | `string` | Icon for multi-action view (ext omitted) |

All title/font fields are user-overridable.

### Encoder Object

| Field | Type | Description |
|---|---|---|
| `background` | `string` | Touch strip background (ext omitted), 200x100 / 400x200 @2x |
| `layout` | `string` | Built-in (`$X1`, `$A0`, `$A1`, `$B1`, `$B2`, `$C1`) or custom JSON path |
| `Icon` | `string` | Dial icon (ext omitted), 72x72 / 144x144 @2x |
| `StackColor` | `string` | Hex background for stacked actions |
| `TriggerDescription` | `object` | See below |

#### TriggerDescription

| Field | Description |
|---|---|
| `Push` | Description for dial press |
| `Rotate` | Description for dial rotation |
| `Touch` | Description for touch tap |
| `LongTouch` | Description for long touch |

### OS Array

```json
"OS": [
  { "Platform": "mac", "MinimumVersion": "13" },
  { "Platform": "windows", "MinimumVersion": "10" }
]
```

### Profiles Array

| Field | Type | Default | Description |
|---|---|---|---|
| `Name` | `string` | -- | Profile path (ext omitted, `.streamDeckProfile`) |
| `DeviceType` | `integer` | -- | Target device type (0-13) |
| `AutoInstall` | `boolean` | `true` | Auto-install on plugin install (6.6+) |
| `DontAutoSwitchWhenInstalled` | `boolean` | `false` | Prevent auto-switch |
| `Readonly` | `boolean` | `false` | Prevent user customization |

### DeviceType Values

| ID | Device |
|---|---|
| 0 | Stream Deck (+ Scissor Keys) |
| 1 | Stream Deck Mini |
| 2 | Stream Deck XL |
| 3 | Stream Deck Mobile |
| 4 | Corsair GKeys |
| 5 | Stream Deck Pedal |
| 6 | Corsair Voyager |
| 7 | Stream Deck + |
| 8 | SCUF Controller |
| 9 | Stream Deck Neo |
| 10 | Stream Deck Studio |
| 11 | Virtual Stream Deck |
| 12 | Galleon 100 SD |
| 13 | Stream Deck + XL |

### Icon Sizing Reference

| Icon Type | Sizes | Format |
|---|---|---|
| Plugin Icon (`Icon`) | 256x256, 512x512 @2x | PNG |
| Action Icon (`Actions[].Icon`) | 20x20, 40x40 @2x | PNG or SVG, white on transparent |
| Category Icon | 28x28, 56x56 @2x | PNG or SVG, white on transparent |
| State Image | 72x72, 144x144 @2x | GIF, PNG, SVG |
| MultiAction Image | 72x72, 144x144 @2x | PNG or SVG |
| Encoder Icon | 72x72, 144x144 @2x | PNG or SVG |
| Encoder Background | 200x100, 400x200 @2x | PNG or SVG |

### File Path Extension Rules

- **Extension omitted**: `Icon`, `CategoryIcon`, `Encoder.Icon`, `Encoder.background`, `States[].Image`, `States[].MultiActionImage`, `Profiles[].Name`
- **Extension required**: `CodePath`, `CodePathMac`, `CodePathWin`, `PropertyInspectorPath`

### Complete Manifest Example

```json
{
  "$schema": "https://schemas.elgato.com/streamdeck/plugins/manifest.json",
  "Actions": [
    {
      "Icon": "imgs/actions/counter/icon",
      "Name": "Counter",
      "UUID": "com.elgato.hello-world.increment",
      "Tooltip": "Increments a count on press.",
      "Controllers": ["Keypad"],
      "States": [
        {
          "Image": "imgs/actions/counter/key",
          "TitleAlignment": "middle"
        }
      ]
    },
    {
      "Icon": "imgs/actions/volume/icon",
      "Name": "Volume",
      "UUID": "com.elgato.hello-world.volume",
      "Controllers": ["Encoder"],
      "Encoder": {
        "layout": "$B1",
        "TriggerDescription": {
          "Rotate": "Adjust volume",
          "Push": "Mute / Unmute",
          "Touch": "Mute / Unmute"
        }
      },
      "States": [{ "Image": "imgs/actions/volume/key" }]
    }
  ],
  "Author": "Elgato",
  "Category": "Hello World",
  "CategoryIcon": "imgs/categories/hello-world",
  "CodePath": "bin/plugin.js",
  "Description": "A demo plugin.",
  "Icon": "imgs/plugin-icon",
  "Name": "Hello World",
  "Nodejs": { "Version": "20", "Debug": "enabled" },
  "OS": [
    { "Platform": "mac", "MinimumVersion": "13" },
    { "Platform": "windows", "MinimumVersion": "10" }
  ],
  "SDKVersion": 2,
  "Software": { "MinimumVersion": "6.6" },
  "UUID": "com.elgato.hello-world",
  "Version": "1.0.0.0"
}
```

---

## 4. Actions

Actions are the core functional units of a plugin. Each action can be assigned to keys, dials, or pedals.

### Controller Types

| Controller | Hardware | Events |
|---|---|---|
| `"Keypad"` | Buttons, pedals, G-Keys | `onKeyDown`, `onKeyUp` |
| `"Encoder"` | Dials + touch strip (SD+) | `onDialRotate`, `onDialDown`, `onDialUp`, `onTouchTap` |

### Registration

Actions are declared in the manifest (`Actions[]`) and implemented as classes extending `SingletonAction`:

```typescript
import streamDeck, { action, SingletonAction, KeyDownEvent } from "@elgato/streamdeck";

@action({ UUID: "com.elgato.hello-world.increment" })
export class IncrementCounter extends SingletonAction {
  override onKeyDown(ev: KeyDownEvent): void | Promise<void> {
    streamDeck.logger.info("Key pressed!");
  }
}
```

**Entry point** (`plugin.ts`):

```typescript
import streamDeck from "@elgato/streamdeck";
import { IncrementCounter } from "./actions/increment-counter";

// Register ALL actions BEFORE connect()
streamDeck.actions.registerAction(new IncrementCounter());

streamDeck.connect();
```

> **Important**: All actions must be registered before calling `streamDeck.connect()`.

### Typed Settings

Use a generic type parameter to get typed settings throughout event handlers:

```typescript
type CounterSettings = {
  count: number;
};

@action({ UUID: "com.elgato.hello-world.increment" })
export class IncrementCounter extends SingletonAction<CounterSettings> {
  override async onKeyDown(ev: KeyDownEvent<CounterSettings>): Promise<void> {
    let count = ev.payload.settings.count ?? 0;
    count++;
    await ev.action.setSettings({ count });
    await ev.action.setTitle(`${count}`);
  }
}
```

### Accessing All Visible Instances

```typescript
// All visible actions (any type)
streamDeck.actions.forEach((action) => {
  action.setTitle("Hello world");
});

// Within a SingletonAction -- only instances of this action type
@action({ UUID: "com.elgato.hello-world.increment" })
export class IncrementCounter extends SingletonAction {
  someMethod() {
    this.actions.forEach((action) => {
      action.setTitle("Updated!");
    });
  }
}
```

**Limitation**: You cannot access or control actions from other plugins.

### Action Instance Methods

| Method | Description |
|---|---|
| `getSettings<T>()` | Get action instance settings |
| `setSettings(settings)` | Persist action instance settings |
| `getResources()` | Get embedded resources (7.1+) |
| `setResources(resources)` | Set embedded resources (7.1+) |
| `isDial()` | Returns `true` if action is on an encoder |
| `isKey()` | Returns `true` if action is on a key |
| `showAlert()` | Flash yellow warning triangle |
| `showOk()` | Flash green checkmark |

---

## 5. Action Lifecycle Events

Override these methods on `SingletonAction`:

### Appearance

| Event | When | Key Data |
|---|---|---|
| `onWillAppear(ev: WillAppearEvent)` | Action becomes visible (page/profile change, startup) | `ev.action`, `ev.payload.controller`, `ev.payload.settings` |
| `onWillDisappear(ev: WillDisappearEvent)` | Action leaves canvas | `ev.action` |

```typescript
override onWillAppear(ev: WillAppearEvent<Settings>): void | Promise<void> {
  const { settings } = ev.payload;
  return ev.action.setTitle(`${settings.count ?? 0}`);
}
```

### Key Events

| Event | When |
|---|---|
| `onKeyDown(ev: KeyDownEvent)` | User presses a key |
| `onKeyUp(ev: KeyUpEvent)` | User releases a key |

```typescript
override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
  let count = ev.payload.settings.count ?? 0;
  count++;
  await ev.action.setSettings({ count });
  await ev.action.setTitle(`${count}`);
}
```

### Dial/Encoder Events

| Event | When | Key Data |
|---|---|---|
| `onDialRotate(ev: DialRotateEvent)` | Dial is rotated | `ev.payload.ticks` (positive=CW, negative=CCW), `ev.payload.pressed` |
| `onDialDown(ev: DialDownEvent)` | Dial is pressed | -- |
| `onDialUp(ev: DialUpEvent)` | Dial is released | -- |
| `onTouchTap(ev: TouchTapEvent)` | Touch strip is tapped | `ev.payload.hold`, tap position |

> **Note**: `dialPress` was removed in Stream Deck 6.5. Use `onDialDown` / `onDialUp` instead.

### Settings Events

| Event | When |
|---|---|
| `onDidReceiveSettings(ev)` | Settings updated by PI or `getSettings()` called |
| `onDidReceiveResources(ev)` | Resources updated in PI (7.1+) |

### Property Inspector Events

| Event | When |
|---|---|
| `onPropertyInspectorDidAppear(ev)` | PI becomes visible |
| `onPropertyInspectorDidDisappear(ev)` | PI is hidden |

### Communication Events

| Event | When |
|---|---|
| `onSendToPlugin(ev)` | Message received from property inspector |
| `onTitleParametersDidChange(ev)` | User modifies title settings in SD app |

### Event Payload Structure

All events provide:

```typescript
ev.action           // Action instance reference
ev.action.device    // Device the action is on
ev.action.device.id // Device identifier
ev.payload.controller  // "Keypad" | "Encoder"
ev.payload.settings    // Current settings object
ev.payload.coordinates // { column: number, row: number }
```

---

## 6. Keys (Keypad)

### States

Keys support up to **2 states** (toggle behavior). Stream Deck automatically toggles state on press unless `DisableAutomaticStates: true` in manifest.

```typescript
// Set state programmatically
await ev.action.setState(0); // or 1
```

For multi-action, access `ev.payload.userDesiredState`.

### setTitle

```typescript
// Simple
await ev.action.setTitle("Hello world!");

// With options
await ev.action.setTitle("Hello world!", {
  state: 0,                        // Which state to set title for
  target: Target.Hardware,          // Hardware, Software, or HardwareAndSoftware
});
```

> Title can only be set by the plugin when the user has **not** specified a custom title.

### setImage

```typescript
// File path (relative to sdPlugin directory)
await ev.action.setImage("imgs/actions/counter/key.png");

// SVG string
const svg = `<svg width="100" height="100">
  <circle fill="${isRed ? 'red' : 'blue'}" r="45" cx="50" cy="50"/>
</svg>`;
await ev.action.setImage(`data:image/svg+xml,${encodeURIComponent(svg)}`);

// Base64 data URI
await ev.action.setImage("data:image/png;base64,iVBORw0KGgo...");

// With options
await ev.action.setImage("imgs/icon.png", {
  target: Target.HardwareAndSoftware,
  state: 1,
});

// Reset to manifest default
await ev.action.setImage(undefined);
```

**Supported formats**: SVG (`image/svg+xml`), PNG, JPEG, WEBP.

**Not supported**: Animated GIF via `setImage()`.

### Visual Feedback

```typescript
await ev.action.showOk();     // Green checkmark flash
await ev.action.showAlert();  // Yellow warning triangle flash
```

### Display Precedence

Rendering priority (highest wins):
1. User-defined titles/images (set in SD app)
2. Runtime values via `setTitle()` / `setImage()`
3. Manifest defaults (`States[].Title`, `States[].Image`)

---

## 7. Dials & Touch Strip (Encoder)

The encoder on Stream Deck + combines a physical dial with a touch strip segment. Each action occupies one quarter of the touch strip (200x100 px).

### Events

```typescript
@action({ UUID: "com.example.volume" })
export class VolumeAction extends SingletonAction {
  // Dial rotation
  override onDialRotate(ev: DialRotateEvent): void | Promise<void> {
    const ticks = ev.payload.ticks;  // positive = clockwise
    const pressed = ev.payload.pressed; // dial pressed while rotating?
  }

  // Dial press
  override onDialDown(ev: DialDownEvent): void | Promise<void> { }

  // Dial release
  override onDialUp(ev: DialUpEvent): void | Promise<void> { }

  // Touch strip tap
  override onTouchTap(ev: TouchTapEvent): void | Promise<void> {
    const hold = ev.payload.hold;
  }
}
```

### setFeedback

Update layout elements by their `key`:

```typescript
// Update text value
await ev.action.setFeedback({ title: "Volume: 75%" });

// Update multiple elements
await ev.action.setFeedback({
  title: "Volume",
  indicator: { value: 75 },
  icon: "data:image/png;base64,..."
});

// Override element properties dynamically
await ev.action.setFeedback({
  my_bar: { value: 75, bar_fill_c: "#E74C3C" },
  my_text: { value: "+18 LP", color: "#2ECC71" }
});
```

Unspecified properties remain unchanged (partial updates).

### setFeedbackLayout

Switch layout at runtime:

```typescript
override onWillAppear(ev: WillAppearEvent): Promise<void> {
  if (ev.action.isDial()) {
    return ev.action.setFeedbackLayout("$B1");       // Built-in
    // or
    return ev.action.setFeedbackLayout("layouts/custom.json"); // Custom
  }
}
```

### setTriggerDescription

Update dial interaction labels at runtime:

```typescript
await ev.action.setTriggerDescription({
  rotate: "Adjust brightness",
  push: "Toggle on/off",
  touch: "Open settings",
  longTouch: "Reset"
});
```

### Built-in Encoder Layouts

| ID | Name | Description |
|---|---|---|
| `$X1` | Icon | Title at top, icon centered below |
| `$A0` | Canvas | Full-width image canvas with title |
| `$A1` | Value | Icon left, title + text value right |
| `$B1` | Indicator | Icon left, value right, progress bar below |
| `$B2` | Gradient | Like $B1 but gradient-mapped bar |
| `$C1` | Double | Two icon/bar pairs with title |

---

## 8. Layouts (Touch Strip)

Layout JSON schema: `https://schemas.elgato.com/streamdeck/plugins/layout.json`

### Canvas

Fixed at **200 x 100 pixels**. Items outside this boundary will not render.

### JSON Structure

```json
{
  "$schema": "https://schemas.elgato.com/streamdeck/plugins/layout.json",
  "id": "my-custom-layout",
  "items": [
    {
      "key": "champ_icon",
      "type": "pixmap",
      "rect": [4, 10, 72, 72],
      "value": ""
    },
    {
      "key": "title",
      "type": "text",
      "rect": [82, 4, 114, 20],
      "value": "Title",
      "font": { "size": 14, "weight": 700 },
      "color": "#3498DB",
      "alignment": "left"
    },
    {
      "key": "wr_bar",
      "type": "bar",
      "rect": [82, 70, 114, 20],
      "value": 50,
      "range": { "min": 0, "max": 100 },
      "bar_fill_c": "#2ECC71",
      "bar_bg_c": "#333333"
    }
  ]
}
```

### Element Types

#### Text

| Property | Type | Required | Default | Notes |
|---|---|---|---|---|
| `type` | `"text"` | Yes | -- | Immutable at runtime |
| `key` | `string` | Yes | -- | Immutable; `"title"` is reserved (enables PI font controls) |
| `rect` | `[x, y, w, h]` | Yes | -- | Canvas coordinates; immutable |
| `value` | `string` | No | -- | Displayed text |
| `color` | `string` | No | `"white"` | Font color; ignored if `key="title"` |
| `alignment` | `string` | No | `"center"` | `"left"`, `"center"`, `"right"`; ignored if `key="title"` |
| `font` | `object` | No | -- | Ignored if `key="title"` |
| `font.size` | `number` | No | -- | Pixel size (whole number) |
| `font.weight` | `number` | No | -- | 100-1000 |
| `text-overflow` | `string` | No | `"clip"` | `"clip"`, `"ellipsis"`, `"fade"` |
| `background` | `string` | No | -- | Background color |
| `enabled` | `boolean` | No | `true` | Visibility toggle |
| `opacity` | `0-1` | No | `1` | 0.1 increments |
| `zOrder` | `number` | No | `0` | 0-700 |

> When `key="title"`, the `color`, `alignment`, and `font` properties are controlled by the user in the PI and are ignored if set in JSON.

#### Pixmap

| Property | Type | Required | Default | Notes |
|---|---|---|---|---|
| `type` | `"pixmap"` | Yes | -- | Immutable |
| `key` | `string` | Yes | -- | Immutable; `"icon"` is reserved (user-overridable in PI) |
| `rect` | `[x, y, w, h]` | Yes | -- | Immutable. **Use square rect for square source images** to avoid stretching |
| `value` | `string` | No | -- | Local path (`imgs/Logo.png`), base64 data URI, or SVG string |
| `background` | `string` | No | -- | Background color |
| `enabled` | `boolean` | No | `true` | Visibility toggle |
| `opacity` | `0-1` | No | `1` | 0.1 increments |
| `zOrder` | `number` | No | `0` | 0-700 |

#### Bar

Horizontal progress bar with fill indicator.

| Property | Type | Required | Default | Notes |
|---|---|---|---|---|
| `type` | `"bar"` | Yes | -- | Immutable |
| `key` | `string` | Yes | -- | Immutable |
| `rect` | `[x, y, w, h]` | Yes | -- | Immutable |
| `value` | `number` | Yes | -- | Fill amount within `range` |
| `range` | `{min, max}` | No | `{min:0, max:100}` | Value boundaries |
| `bar_bg_c` | `string` | No | `"darkGray"` | Background color |
| `bar_fill_c` | `string` | No | `"white"` | Fill color |
| `bar_border_c` | `string` | No | `"white"` | Border color |
| `border_w` | `number` | No | `2` | Border width |
| `subtype` | `0-4` | No | `4` (Groove) | Shape: Rectangle(0), DoubleRectangle(1), Trapezoid(2), DoubleTrapezoid(3), Groove(4) |
| `background` | `string` | No | -- | Canvas background |
| `enabled` | `boolean` | No | `true` | Visibility |
| `opacity` | `0-1` | No | `1` | |
| `zOrder` | `number` | No | `0` | 0-700 |

#### GBar

Same as Bar but adds a **triangle indicator** below the bar at the current position.

All Bar properties apply, plus:

| Property | Type | Default | Notes |
|---|---|---|---|
| `bar_h` | `number` | `10` | Height of the indicator triangle |

### Color Formats

All color properties support:

- **Named colors**: `"white"`, `"pink"`, `"darkGray"`, etc.
- **Hex**: `"#204cfe"`, `"#FF0000"`
- **Gradients**: `"0:#ff0000,0.5:yellow,1:#00ff00"` (format: `offset:color[,offset:color,...]`)

### Reserved Keys

- `"title"` -- text element linked to PI font controls and `setTitle()`. `color`, `alignment`, `font` are ignored (user-controlled).
- `"icon"` -- pixmap element linked to PI icon picker and `setImage()`.

### Runtime Constraints

- `rect`, `type`, and `key` **cannot be changed at runtime**.
- Items at the same `zOrder` must **not** have overlapping `rect` coordinates.
- Use `setFeedback()` to update `value`, `color`, `bar_fill_c`, etc.
- Use `setFeedbackLayout()` to switch entire layouts.

### setFeedback Patterns

```typescript
// Text -- value only (uses layout color)
await action.setFeedback({ my_text: "Hello" });

// Text -- override color dynamically
await action.setFeedback({ my_text: { value: "+18 LP", color: "#2ECC71" } });

// Bar -- override fill color
await action.setFeedback({ my_bar: { value: 75, bar_fill_c: "#E74C3C" } });

// Pixmap -- set image
await action.setFeedback({ champ_icon: "data:image/png;base64,..." });

// Pixmap -- clear image
await action.setFeedback({ champ_icon: "" });

// Multiple elements at once
await action.setFeedback({
  title: "Ranked",
  rank_text: { value: "Gold II", color: "#FFD700" },
  lp_bar: { value: 75 },
  rank_icon: dataUri
});
```

### Validate Layouts

```bash
streamdeck validate
```

Checks that layout items stay within canvas boundaries.

---

## 9. Images & Icons

### Sizing Convention

All image references in `manifest.json` use **extension-omitted paths**. Provide two files:

```
imgs/actions/counter/icon.png       # @1x (20x20, 72x72, etc.)
imgs/actions/counter/icon@2x.png    # @2x (40x40, 144x144, etc.)
```

Stream Deck selects the appropriate resolution automatically.

### setImage Formats

| Format | Usage |
|---|---|
| File path | `"imgs/actions/counter/key.png"` (relative to `.sdPlugin/`) |
| SVG data URI | `"data:image/svg+xml," + encodeURIComponent(svgString)` |
| SVG base64 | `"data:image/svg+xml;base64," + btoa(svgString)` |
| PNG base64 | `"data:image/png;base64," + base64String` |
| JPEG base64 | `"data:image/jpeg;base64," + base64String` |
| WEBP base64 | `"data:image/webp;base64," + base64String` |

### SVG Key Images

SVGs are the recommended format for dynamic key images. They support full CSS, embedded base64 PNGs, text rendering, and can be composed inline:

```typescript
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
  <rect width="144" height="144" rx="16" fill="#1a1a2e"/>
  <image href="data:image/png;base64,${championIconBase64}"
         x="10" y="10" width="60" height="60"/>
  <text x="72" y="120" fill="white" font-size="24"
        text-anchor="middle">${championName}</text>
</svg>`;

await action.setImage(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
```

### Image Sizing Quick Reference

| Context | @1x | @2x | Notes |
|---|---|---|---|
| Plugin icon | 256x256 | 512x512 | PNG only |
| Action list icon | 20x20 | 40x40 | White on transparent |
| Category icon | 28x28 | 56x56 | White on transparent |
| Key state image | 72x72 | 144x144 | GIF, PNG, SVG |
| Encoder icon | 72x72 | 144x144 | PNG, SVG |
| Encoder background | 200x100 | 400x200 | PNG, SVG |
| Touch strip canvas | 200x100 | -- | Layout coordinate space |

---

## 10. Settings

### Two Scopes

| Scope | Persistence | Access | Use Case |
|---|---|---|---|
| **Action Settings** | Per action instance | Plugin + PI | Count, mode, user preferences per button |
| **Global Settings** | Per plugin | Plugin + PI | API tokens, plugin-wide config |

Both persist as JSON objects (`boolean`, `number`, `string`, `null`, arrays, objects).

### Action Settings

#### Write

```typescript
await ev.action.setSettings({ count: 5, mode: "auto" });
```

#### Read

```typescript
// From event payload (recommended -- available in most events)
const { count = 0 } = ev.payload.settings;

// Via method (only while action is visible)
const settings = await ev.action.getSettings<MySettings>();
```

#### React to Changes

```typescript
override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
  const { mode } = ev.payload.settings;
  // PI changed settings, react here
}
```

#### Type Safety

```typescript
type CounterSettings = { count: number };

@action({ UUID: "com.example.counter" })
export class Counter extends SingletonAction<CounterSettings> {
  // ev.payload.settings is typed as CounterSettings
  override async onKeyDown(ev: KeyDownEvent<CounterSettings>) {
    let { count = 0 } = ev.payload.settings;
    count++;
    await ev.action.setSettings({ count });
  }
}
```

Use default values (`?? 0`, `= 0`) since TypeScript types don't guarantee runtime correctness. For stricter validation, use [Zod](https://github.com/colinhacks/zod):

```typescript
import { z } from "zod";
const Settings = z.object({ name: z.string().default("Elgato") });
const { name } = Settings.parse(ev.payload.settings);
```

### Global Settings

#### Write

```typescript
await streamDeck.settings.setGlobalSettings({ apiKey: "abc123" });
```

#### Read

```typescript
type GlobalConfig = { apiKey: string };
const { apiKey } = await streamDeck.settings.getGlobalSettings<GlobalConfig>();
```

#### React to Changes

```typescript
streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
  const settings = ev.settings;
});
```

### Bidirectional Sync

When either side (plugin or PI) calls `setSettings()` or `setGlobalSettings()`, the other side is automatically notified via the corresponding `didReceiveSettings` / `didReceiveGlobalSettings` event.

### Experimental Message Identifiers

```typescript
streamDeck.settings.useExperimentalMessageIdentifiers = true;
```

When enabled, `onDidReceiveSettings` / `onDidReceiveGlobalSettings` only fire when settings actually **change**, not on every `get` request.

### Security

- **DO**: Store API keys, OAuth tokens in **global settings** (encrypted locally)
- **DO**: Use global settings for non-sensitive plugin-wide config
- **DON'T**: Store sensitive data in **action settings** (plain-text, included in profile exports)
- **DON'T**: Include private API keys in packaged plugin code

---

## 11. Property Inspectors (UI)

Property inspectors are HTML web views for user-facing configuration.

### File Setup

Place HTML files in `*.sdPlugin/ui/`:

```
*.sdPlugin/
├── ui/
│   └── my-action.html
└── manifest.json
```

Reference in manifest:

```json
// Per-action PI
{
  "Actions": [{
    "PropertyInspectorPath": "ui/my-action.html"
  }]
}

// Global PI (shared by all actions)
{
  "PropertyInspectorPath": "ui/settings.html"
}
```

### sdpi-components Library

Web component library for building property inspectors. Handles plugin communication automatically.

**Local (recommended)**:

```html
<script src="sdpi-components.js"></script>
```

**CDN (prototyping only)**:

```html
<script src="https://sdpi-components.dev/releases/v4/sdpi-components.js"></script>
```

### Basic HTML Structure

```html
<!doctype html>
<html>
<head>
  <script src="sdpi-components.js"></script>
</head>
<body>
  <sdpi-item label="Name">
    <sdpi-textfield setting="name"></sdpi-textfield>
  </sdpi-item>

  <sdpi-item label="Color">
    <sdpi-select setting="color">
      <option value="red">Red</option>
      <option value="blue">Blue</option>
    </sdpi-select>
  </sdpi-item>

  <sdpi-item label="Enabled">
    <sdpi-checkbox setting="enabled"></sdpi-checkbox>
  </sdpi-item>

  <sdpi-item label="Volume">
    <sdpi-range setting="volume" min="0" max="100"></sdpi-range>
  </sdpi-item>
</body>
</html>
```

### Available Components

| Component | Description |
|---|---|
| `<sdpi-textfield>` | Text input |
| `<sdpi-password>` | Password input |
| `<sdpi-textarea>` | Multi-line text |
| `<sdpi-select>` | Dropdown select |
| `<sdpi-radio>` | Radio buttons |
| `<sdpi-checkbox>` | Checkbox |
| `<sdpi-checkbox-list>` | Multiple checkboxes |
| `<sdpi-color>` | Color picker |
| `<sdpi-calendar>` | Date/time picker (multiple types) |
| `<sdpi-range>` | Slider |
| `<sdpi-file>` | File picker |
| `<sdpi-delegate>` | Custom component |
| `<sdpi-button>` | Button |

The `setting="key"` attribute on each component automatically maps to the action's settings JSON. Values are persisted on change.

### Manual Communication (without sdpi-components)

Access via `SDPIComponents.streamDeckClient`:

```javascript
const { streamDeckClient } = SDPIComponents;

// Set settings manually
streamDeckClient.setSettings({
  name: "John Doe",
  showName: true,
  favColor: "green"
});

// Send message to plugin
streamDeckClient.sendToPlugin({ action: "refresh" });
```

### Plugin-Side Handling

```typescript
@action({ UUID: "com.example.my-action" })
export class MyAction extends SingletonAction<Settings> {
  // React to PI settings changes
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    const { mode } = ev.payload.settings;
    // Apply new settings
  }

  // Receive custom messages from PI
  override onSendToPlugin(ev: SendToPluginEvent): void {
    const { action } = ev.payload;
    if (action === "refresh") {
      // handle
    }
  }

  // Send data back to PI
  override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent): void {
    ev.action.sendToPropertyInspector({ status: "connected" });
  }
}
```

### Debugging Property Inspectors

1. Enable dev mode: `streamdeck dev`
2. Open `http://localhost:23654/` in a browser
3. The PI must be visible in Stream Deck to appear in the debugger list

---

## 12. Profiles

Profiles are pre-configured button layouts bundled with plugins.

### Creating Profiles

1. Drag plugin actions onto the Stream Deck canvas
2. Export via SD preferences as `.streamDeckProfile`
3. Place in the `.sdPlugin/` directory

### Manifest Registration

```json
{
  "Profiles": [
    {
      "Name": "profiles/MyProfile",
      "DeviceType": 0,
      "Readonly": false,
      "DontAutoSwitchWhenInstalled": false,
      "AutoInstall": true
    }
  ]
}
```

### Switching Profiles Programmatically

```typescript
override onKeyDown(ev: KeyDownEvent): void | Promise<void> {
  streamDeck.profiles.switchToProfile(ev.action.device.id, "My Cool Profile");
}
```

**Parameters**:
- `deviceId` -- target device identifier (from `ev.action.device.id`)
- `profileName` -- name as defined in manifest

**Limitations**:
- Can only switch to profiles **bundled with the plugin**
- Cannot access or switch to user-defined profiles

---

## 13. Deep Linking

### URL Format

```
streamdeck://plugins/message/<PLUGIN_UUID>[path][?query][#fragment]
```

Example:
```
streamdeck://plugins/message/com.elgato.hello-world/hello?name=Elgato#waving
```

### OAuth2 Redirect Proxy

```
https://oauth2-redirect.elgato.com/streamdeck/plugins/message/<PLUGIN_UUID>
```

Only these query params are forwarded: `code`, `state`, `scope`, `error`.

### Handling Deep Links

```typescript
import streamDeck from "@elgato/streamdeck";

streamDeck.system.onDidReceiveDeepLink((ev) => {
  const { path, fragment } = ev.url;
  const name = ev.url.searchParams.get("name");
  streamDeck.logger.info(`Path: ${path}, Name: ${name}, Fragment: ${fragment}`);
});

streamDeck.connect();
```

### Active vs Passive

| Mode | Behavior | Requirement |
|---|---|---|
| **Active** (default) | SD window brought to foreground | SD 6.5+ |
| **Passive** | Window stays hidden | SD 7.0+; add `?streamdeck=hidden` to URL |

### Limitations

- URL schemes not supported by all OAuth providers
- Messages limited to under 2,000 characters
- Deep links are local only (no remote access)

---

## 14. Devices

### Accessing Devices

```typescript
streamDeck.devices.forEach((device) => {
  console.log(device.id, device.name, device.type, device.size, device.isConnected);
});
```

### Device Events

```typescript
// Device connected
streamDeck.devices.onDeviceDidConnect((ev) => {
  console.log(`Connected: ${ev.device.name}`);
});

// Device changed (7.0+)
streamDeck.devices.onDeviceDidChange((ev) => {
  console.log(`Changed: ${ev.device.name}`);
});

// Device disconnected
streamDeck.devices.onDeviceDidDisconnect((ev) => {
  console.log(`Disconnected: ${ev.device.id}`);
  // UI elements remain visible in app despite hardware disconnect
});
```

### Device Specifications

| Type | Device | Keys | Dials | Touch |
|---|---|---|---|---|
| 0 | Stream Deck | LCD keys | -- | -- |
| 1 | Stream Deck Mini | LCD keys | -- | -- |
| 2 | Stream Deck XL | 32 LCD keys | -- | -- |
| 3 | Stream Deck Mobile | Up to 64 LCD keys | -- | -- |
| 5 | Stream Deck Pedal | 3 pedals | -- | -- |
| 7 | Stream Deck + | 8 LCD keys | 4 dials | Touch strip |
| 9 | Stream Deck Neo | 8 LCD keys | -- | 2 touch buttons |
| 13 | Stream Deck + XL | -- | -- | -- |

---

## 15. System Events

### Open URL

```typescript
streamDeck.system.openUrl("https://elgato.com");
```

Opens the user's default browser. Custom URL schemes (e.g. `my-app://`) are not supported.

### System Wake

```typescript
streamDeck.system.onSystemDidWakeUp((ev) => {
  // Restore connections, refresh state after system sleep
  // Also fires onWillAppear for all visible actions
});
```

Use this to re-establish WebSocket connections, IPC, or refresh stale data after the computer wakes from sleep.

---

## 16. Application Monitoring

### Manifest Configuration

```json
{
  "ApplicationsToMonitor": {
    "mac": ["com.apple.mail", "com.google.Chrome"],
    "windows": ["Notepad.exe", "chrome.exe"]
  }
}
```

- **Windows**: executable filename (e.g. `"Elgato Wave Link.exe"`)
- **macOS**: `CFBundleIdentifier` (e.g. `"com.elgato.WaveLink"`)

### Events

```typescript
streamDeck.system.onApplicationDidLaunch((ev) => {
  streamDeck.logger.info(`Launched: ${ev.application}`);
});

streamDeck.system.onApplicationDidTerminate((ev) => {
  streamDeck.logger.info(`Terminated: ${ev.application}`);
});
```

---

## 17. Embedded Resources

> Requires Stream Deck 7.1+

Resources (audio files, configs, etc.) embedded into action instances make profiles portable.

### Set Resources

```typescript
await ev.action.setResources({
  audioFile: ev.payload.settings.userSelectedFile,
});
```

### Get Resources

```typescript
const filePath = ev.payload.resources.audioFile;
// or
const resources = await ev.action.getResources();
```

### Event

```typescript
override onDidReceiveResources(ev): void {
  // Triggered when resources are updated in PI
}
```

File paths are automatically updated during export/import to maintain portability.

---

## 18. Logging & Debugging

### Logger API

```typescript
import streamDeck from "@elgato/streamdeck";

streamDeck.logger.error("Critical failure");    // console.error()
streamDeck.logger.warn("Recoverable issue");    // console.warn()
streamDeck.logger.info("General info");         // console.log()
streamDeck.logger.debug("Dev diagnostic");
streamDeck.logger.trace("Detailed flow");
```

### Log Levels

| Level | Default (Dev) | Default (Prod) |
|---|---|---|
| `ERROR` | Yes | Yes |
| `WARN` | Yes | Yes |
| `INFO` | Yes | Yes (minimum) |
| `DEBUG` | Yes (minimum) | No |
| `TRACE` | No | No |

Set level:

```typescript
streamDeck.logger.setLevel("trace"); // "error" | "warn" | "info" | "debug" | "trace"
```

### Scoped Loggers

```typescript
const mainLogger = streamDeck.logger.createScope("Main");
mainLogger.info("Hello");
// Output: "Main: Hello"

const nestedLogger = mainLogger.createScope("Nested");
nestedLogger.info("Test");
// Output: "Main->Nested: Test"
```

### Log File Location

```
[PluginUUID].sdPlugin/logs/[PluginUUID].[index].log
```

Example: `com.desstroct.lol-api.sdPlugin/logs/com.desstroct.lol-api.0.log`

**Stream Deck application logs:**
- Windows: `%appdata%\Elgato\StreamDeck\logs\`
- macOS: `~/Library/Logs/ElgatoStreamDeck/`

### Log File Specs

- Format: `<iso_date> <log_level> [[scope]: ]<message>`
- 10 most recent files retained (indexed 0-9, newest = 0)
- 10 MiB maximum per file
- New file on plugin startup or size threshold

### Debugging

#### Enable Dev Mode

```bash
streamdeck dev
```

#### Node.js Inspector

Set in manifest:

```json
{
  "Nodejs": {
    "Version": "20",
    "Debug": "enabled"
  }
}
```

- `"enabled"` -- passes `--inspect` (attach debugger)
- `"break"` -- passes `--inspect-brk` (break on start)

#### VS Code Debugging

1. `Ctrl+P` in VS Code
2. Type `> Debug: Attach to Node.js Process`
3. Select the plugin's Node.js process

#### PI Debugging

1. Run `streamdeck dev`
2. Open `http://localhost:23654/` in browser
3. PI must be visible in Stream Deck to appear in debugger list

---

## 19. Localization (i18n)

### Supported Languages

| Language | File |
|---|---|
| Chinese (Simplified) | `zh_CN.json` |
| Chinese (Traditional) | `zh_TW.json` (6.8+) |
| German | `de.json` |
| English | `en.json` |
| French | `fr.json` |
| Japanese | `ja.json` |
| Korean | `ko.json` |
| Spanish | `es.json` |

### File Placement

```
*.sdPlugin/
├── de.json
├── en.json
├── es.json
├── fr.json
├── ja.json
├── ko.json
├── zh_CN.json
├── zh_TW.json
└── manifest.json
```

### Localizable Manifest Fields

- Root: `Name`, `Description`
- Actions: `Name`, `Tooltip`, `States[].Name`
- Encoder: `TriggerDescription.{Push, Rotate, Touch, LongTouch}`

### File Structure

```json
{
  "Name": "Translated Plugin Name",
  "Description": "Translated description",
  "com.example.plugin.my-action": {
    "Name": "Translated Action Name",
    "Tooltip": "Translated tooltip",
    "States": [{ "Name": "State 1" }],
    "Encoder": {
      "TriggerDescription": {
        "Rotate": "Adjust"
      }
    }
  },
  "Localization": {
    "greeting": "Hallo"
  }
}
```

### Custom Strings

```typescript
streamDeck.i18n.translate("greeting");        // Uses current language
streamDeck.i18n.translate("greeting", "de");  // Force German
```

Resolution order: requested language -> English fallback -> original key string.

---

## 20. WebSocket API Reference

The Node.js SDK abstracts the WebSocket protocol, but understanding it helps with debugging and advanced use cases.

### Connection

Plugin receives CLI args: `-port`, `-pluginUUID`, `-registerEvent`, `-info`.

Registration message:
```json
{ "event": "<registerEvent>", "uuid": "<pluginUUID>" }
```

### Events Received by Plugin

| Event | Description |
|---|---|
| `willAppear` | Action becomes visible |
| `willDisappear` | Action leaves canvas |
| `keyDown` / `keyUp` | Key press/release |
| `dialDown` / `dialUp` | Dial press/release |
| `dialRotate` | Dial rotation (`ticks`, `pressed`) |
| `touchTap` | Touch strip tap (`hold`, position) |
| `didReceiveSettings` | Settings updated or requested |
| `didReceiveGlobalSettings` | Global settings updated or requested |
| `didReceiveResources` | Resources updated (7.1+) |
| `didReceiveDeepLink` | Deep link message received |
| `sendToPlugin` | Message from PI |
| `propertyInspectorDidAppear` | PI opened |
| `propertyInspectorDidDisappear` | PI closed |
| `titleParametersDidChange` | User changed title settings |
| `applicationDidLaunch` | Monitored app launched |
| `applicationDidTerminate` | Monitored app terminated |
| `deviceDidConnect` | Device connected |
| `deviceDidDisconnect` | Device disconnected |
| `deviceDidChange` | Device changed (7.0+) |
| `systemDidWakeUp` | Computer woke from sleep |

### Commands Sent by Plugin

| Command | Description |
|---|---|
| `setSettings` | Persist action settings |
| `getSettings` | Request action settings |
| `setGlobalSettings` | Persist global settings |
| `getGlobalSettings` | Request global settings |
| `setResources` / `getResources` | Manage embedded resources (7.1+) |
| `setImage` | Update key image |
| `setTitle` | Update key title |
| `setState` | Set action state (0 or 1) |
| `setFeedback` | Update layout elements |
| `setFeedbackLayout` | Switch encoder layout |
| `setTriggerDescription` | Update dial interaction labels |
| `showOk` | Flash green checkmark |
| `showAlert` | Flash yellow warning |
| `switchToProfile` | Switch device profile |
| `sendToPropertyInspector` | Send message to PI |
| `openUrl` | Open URL in default browser |
| `logMessage` | Write to log file |

### Payload Fields

```typescript
{
  action: string;      // Action UUID
  context: string;     // Action instance ID (not persistent across app restarts)
  device: string;      // Device identifier
  payload: {
    controller: "Keypad" | "Encoder";
    coordinates: { column: number; row: number };
    settings: JsonObject;
    state?: number;
    isInMultiAction?: boolean;
    userDesiredState?: number;  // Multi-action only
  }
}
```

### PI WebSocket Events

| Received by PI | Sent by PI |
|---|---|
| `didReceiveSettings` | `setSettings` |
| `didReceiveGlobalSettings` | `setGlobalSettings` |
| `didReceiveResources` | `setResources` / `getResources` |
| `sendToPropertyInspector` | `sendToPlugin` |
| -- | `openUrl` |

PI registration function:
```typescript
window.connectElgatoStreamDeckSocket = (port, uuid, event, info, actionInfo) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.onopen = () => ws.send(JSON.stringify({ event, uuid }));
};
```

The `sdpi-components` library automates this registration.

---

## 21. Distribution & Packaging

### Packaging

```bash
streamdeck pack com.elgato.hello-world.sdPlugin
```

Produces a `.streamDeckPlugin` installer file. Exclude files using `.sdignore` (same format as `.gitignore`).

### DRM Protection (SDK v2+)

Enables file encryption and integrity checking:

1. Use `@elgato/streamdeck` v2+
2. Set `SDKVersion: 3` in manifest
3. Set `Software.MinimumVersion` to `"6.9"` or higher
4. Upload to Maker Console (DRM activates on upload, not locally)

**Constraints under DRM**:
- Plugin files are immutable after distribution
- Manifest cannot be accessed at runtime (`streamDeck.manifest` removed)
- Generate any needed files dynamically

### Publishing

1. Review plugin guidelines
2. Create app icon (256x256 / 512x512)
3. Create gallery/showcase assets
4. Submit via [Maker Console](https://developer.elgato.com)

---

## 22. SDK v2 Breaking Changes

### 1. UI Communication

```typescript
// Before (v1)
streamDeck.ui.current?.sendToPropertyInspector({ message: "Hello" });
streamDeck.ui.current  // access action

// After (v2)
streamDeck.ui.sendToPropertyInspector({ message: "Hello" });
streamDeck.ui.action   // access action
```

### 2. Decoupled Dependencies

```typescript
// JSON types -- moved to @elgato/utils
import type { JsonObject, JsonPrimitive, JsonValue } from "@elgato/utils";

// LogLevel -- now string, not enum
streamDeck.logger.setLevel("trace");  // was LogLevel.TRACE

// Utilities -- moved to @elgato/utils
import { Enumerable, EventEmitter, EventsOf } from "@elgato/utils";
```

### 3. Manifest Access Removed

`streamDeck.manifest` no longer available at runtime (DRM protection).

### 4. Browser Import Disabled

Cannot import `@elgato/streamdeck` in PI/browser context.

---

## 23. Best Practices

### Polling

- Use `setInterval` with reasonable intervals (1-3s typical).
- Always stop polling in `onWillDisappear` when no action instances remain.
- Guard every polling cycle with connection/state checks:

```typescript
private async updateState(): Promise<void> {
  if (!lcuConnector.isConnected()) { /* show offline */ return; }
  if (gameMode.isTFT()) { /* show N/A */ return; }
  const phase = await lcuApi.getGameflowPhase();
  if (phase !== "ChampSelect") { /* reset */ return; }
  // ... actual logic
}
```

### Error Handling

- Use `showAlert()` to visually indicate errors on the key.
- Implement retry cooldowns to avoid infinite retry loops:

```typescript
state.fetchFailedUntil = Date.now() + 30_000; // 30s cooldown
```

- Wrap fetch/API calls in try/catch and log errors.

### Performance

- Cache API responses (use `DiskCache` or in-memory maps).
- Debounce writes to disk.
- Use `DisableCaching: false` (default) to let Stream Deck cache images.
- Batch `setFeedback()` calls -- update multiple elements in one call.
- Avoid unnecessary `setImage()` calls (check if the image actually changed).

### Settings

- Use `ev.payload.settings` (event payload) over `getSettings()` method when possible.
- Always provide default values with `??` or destructuring defaults.
- Store secrets (API keys, tokens) in **global settings** (locally encrypted), never in action settings (exposed in profile exports).

### Multi-Instance Management

- Use `Map<actionId, State>` to track per-instance state.
- Initialize state lazily in event handlers.
- Clean up state in `onWillDisappear`.
- Access all instances via `this.actions` (on `SingletonAction`).

### Image Optimization

- Use SVG for dynamic content (composable, resolution-independent).
- Use @2x images for crisp rendering on high-DPI displays.
- Use **square `rect`** for square source images in layouts (avoids stretching).
- Prefetch and cache icon data URIs to avoid repeated encoding.

### Shutdown

- Flush caches on process signals (`SIGTERM`, `SIGINT`, `SIGHUP`, `beforeExit`).
- Guard against `EPIPE` / `ERR_STREAM_DESTROYED` on stdout/stderr.

### Layout Design

- Canvas is 200x100 px. Left panel: icon at ~`[4, 10, 72, 72]`. Right panel: text/bars from x=82.
- Use `gbar` for 0-100 gauges (LP, gold progress) -- adds a triangle indicator.
- Use `bar` for simple progress indicators.
- Dynamic colors via `setFeedback()` override layout defaults without changing the layout file.

### Development Workflow

```bash
# 1. Make code changes
# 2. Build
npm run build
# 3. Restart plugin
streamdeck restart com.your.plugin.uuid
# 4. Or use watch mode for auto-rebuild + restart
npm run watch
```

### CLI Commands Reference

| Command | Description |
|---|---|
| `streamdeck create` | Scaffold new plugin project |
| `streamdeck restart <uuid>` | Restart a running plugin |
| `streamdeck dev` | Enable developer mode (PI debugging) |
| `streamdeck validate` | Validate plugin manifest and layouts |
| `streamdeck pack <dir>` | Package into `.streamDeckPlugin` |

---

## Appendix: Changelog Highlights

| SD Version | Key Changes |
|---|---|
| **7.1** | Embedded resources, Node.js 24, in-app dev tools for PI |
| **7.0** | `onDeviceDidChange`, passive deep-links (`?streamdeck=hidden`), `SupportedInKeyLogicActions`, Virtual SD device |
| **6.9** | `SupportURL` in manifest, SD Studio support, improved deep-link URL parsing |
| **6.6** | OS-specific actions, SD Neo support, `AutoInstall` for profiles |
| **6.5** | `dialPress` removed (use `dialDown`/`dialUp`), active deep-links |
| **6.4** | Node.js plugin support (beta) |
