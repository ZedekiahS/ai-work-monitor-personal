# AI Quota Window Native — third-party notices

Product: Copyright (c) 2026 ZedekiahS, MIT. Windows WPF/.NET Framework 4.8 is a system prerequisite and is not redistributed.

## codex-quota-orb (MIT)

Copyright (c) 2026 Codex Quota Orb contributors.
Source: https://github.com/CW12138/codex-quota-orb/blob/0ce1582050c937c86f8d2706ab765819f39b4c31/CodexRateWidget.ps1
Reused the two periodic cubic wave paths from OrbWaveBack/OrbWaveFront and adapted Update-OrbAnimationFrame's layered translations to C#/WPF. Changed period alignment, water level endpoints, palette, opacity, window dimensions and controls. No account switcher, history, analytics, login credential handling, or mirrored quota was copied.
Full license: licenses/codex-quota-orb-LICENSE.

## codex-usage-desktop (MIT)

Copyright (c) 2026 vincent.
Source: https://github.com/itvincent-git/codex-usage-desktop (protocol source attribution inherited from collector/quota-wire.ts, commit d7e04c43a7e1fe11c8dadee90908d70e19983569, src-tauri/src/codex_limits.rs).
C# port of this repository's bounded quota-only RPC adapter. Preserves read-only arguments, hooks disabled, multi-pool parsing, unknowns, identity guard, throttle/backoff and cleanup. Omits usage queries and all Monitor persistence.
Full license: licenses/codex-usage-desktop-LICENSE.

## Design reference only

ArloYi/Codex-Token-Monitor at 2e0f64c3fe37d3222e8a80485b34d150865a55f7, Windows/Hud.cs (MIT) was inspected for native window/tray and lightweight runtime feasibility. No source copied; our UI uses WPF rather than its WinForms/GDI+ shell.
