# Sharing Notes without the Microsoft Store

The Microsoft Store needs a paid developer account (~$19 one-time). You do **not**
need it to ship the app. Everything below is free.

## What you build

```powershell
npm run electron:build
```

Produces in `release/`:

| File | What it is |
|---|---|
| `Notes Setup 1.0.0.exe` | Normal installer (per-user, no admin needed) |
| `win-unpacked/Notes.exe` | The app itself, runs without installing |

Optional: a zip of the unpacked app, for people who don't want an installer.

```powershell
Compress-Archive -Path "release/win-unpacked/*" -DestinationPath "release/Notes-portable.zip" -Force
```

## Where to host it (free)

| Service | Cost | Notes |
|---|---|---|
| **GitHub Releases** | Free | Best option. Public repo, attach the `.exe`, get a permanent download link. No file size limit in practice (2 GB per file). |
| **itch.io** | Free | Built for indie apps, handles downloads and a simple page. |
| **Google Drive / OneDrive** | Free | Easiest, but the link can break and there's no update path. |

### GitHub Releases, step by step

1. Create a free GitHub account.
2. New repository, e.g. `notes-app`. Public or private both work.
3. On the repo page: **Releases → Create a new release**.
4. Tag it `v1.0.0`, title it `Notes 1.0.0`.
5. Attach `release/Notes Setup 1.0.0.exe` (and `Notes-portable.zip` if you made it).
6. Publish. The download link is permanent and free.

## The one honest caveat

The app is not code-signed, so Windows may show a warning the first time someone
runs it:

- **"Windows protected your PC"** (SmartScreen) → click **More info** → **Run anyway**.
- **"An Application Control policy has blocked this file"** → this only happens on
  PCs with Smart App Control turned on. Those users must turn it off in
  Windows Security, or use the app on another PC.

A code-signing certificate removes both warnings but costs $100+/year. For a free
app shared with friends or a small audience, the warning is normal and most people
know the **More info → Run anyway** step.

## Updating the app

1. Change `version` in `package.json` (e.g. `1.0.1`).
2. Run `npm run electron:build`.
3. Create a new GitHub release with the new `.exe`.

People who installed with the installer get a normal upgrade over the old version —
their notes stay, because notes are stored in the app's local storage, not next to
the exe.

## If you ever want the Store

Nothing is lost. The Store build is still one command away:

```powershell
npm run electron:build:store
```

It produces `release/Notes 1.0.0.appx`, ready for Partner Center once you have an
account and have set your identity values with `scripts/set-identity.ps1`.
