# Releasing FogOfWar.exe

FogOfWar.exe is built by GitHub Actions (`.github/workflows/fogofwar.yml`).
The exe is not code-signed, so Windows shows a SmartScreen warning the first
time it runs (More info, then Run anyway).

## Making a build

There are four ways to start a build:

| How | Result |
|---|---|
| Merge a change to `cmd/fogofwar/VERSION` into main (the usual way: every app change bumps it) | The GitHub release `fogofwar/v<VERSION>`, tagged at the merge commit. Nothing is published if that tag already exists. |
| Actions > FogOfWar > Run workflow, version left empty | A test build. It is kept as the run's `FogOfWar` artifact for 14 days, and no release is made. |
| Run workflow with a version, e.g. `0.3.0` | The GitHub release `fogofwar/v0.3.0`, with the exe and its sha256. The tag is created at the commit the run built. |
| `git tag fogofwar/v0.3.0 && git push origin fogofwar/v0.3.0` | The same release, built from the pushed tag. |

Every release is marked latest, and replay.fogofwar.dev/setup's download
button points at `releases/latest/download/FogOfWar.exe`, so a new release is
what the page serves with no other change. Keep the asset named `FogOfWar.exe`.

A release version is always `major.minor.patch`. A manual run refuses a
version whose tag already exists. Other pushes to main build nothing.

The same version is written into three places: the exe's version resource
(`go run ./winres -version`), `main.version` (the app logs it and reports it
on every job), and the release tag.
