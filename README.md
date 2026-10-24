# Eclipse Launcher

Starter Electron launcher for Eclipse.

## Current milestone
- Custom purple scrollbar
- Local instance discovery from `instances/` during development
- Official Minecraft.net RSS news feed
- Clicking Read More opens the official Minecraft article in an Eclipse child window

## Instance layout
Put an instance directly inside `instances/`, for example:

```text
instances/
└── 1.20.1-PVP/
    ├── config/
    ├── mods/
    ├── resourcepacks/
    ├── ...
    └── eclipse-instance.json
```

The `eclipse-instance.json` belongs in the root of the instance folder, next to `config`, `mods`, etc.

Example:

```json
{
  "name": "PvP",
  "version": "1.20.1",
  "loader": "Fabric",
  "lastPlayed": 0
}
```

Run `npm install`, then `npm start`.
