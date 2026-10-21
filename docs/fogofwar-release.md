# Releasing FogOfWar.exe

FogOfWar.exe is built by GitHub Actions (`.github/workflows/fogofwar.yml`) and
signed by [SignPath Foundation](https://signpath.org), which signs open-source
projects for free under its own certificate. The exe then shows
"SignPath Foundation" as its publisher.

## Making a build

Nothing builds on an ordinary push. There are three ways to start a build:

| How | Result |
|---|---|
| Actions > FogOfWar > Run workflow, version left empty | An unsigned test build. It is kept as the run's `FogOfWar-unsigned` artifact for 14 days, and no release is made. |
| Run workflow with a version, e.g. `0.3.0` | A signed build, published as the GitHub release `fogofwar/v0.3.0`. The tag is created at the commit the run built. |
| `git tag fogofwar/v0.3.0 && git push origin fogofwar/v0.3.0` | The same signed release, built from the pushed tag. |

A release version is always `major.minor.patch`. The workflow refuses a
version whose tag already exists.

The same version is written into three places: the exe's version resource
(`go run ./winres -version`, which SignPath checks), `main.version` (the app
logs it and reports it on every job), and the release tag.

Until signing is set up (below), a release is published **unsigned**, and its
notes say so. This is also how to make the "already released" version that
SignPath asks to see before it accepts a project.

Signing waits for a person to approve each request on signpath.io. SignPath
Foundation approves every release by hand, so the run sits in the
"Sign with SignPath" step until then, for at most 5 hours.

## Setting up SignPath (once)

1. **Meet the conditions** in the [SignPath Foundation terms](https://signpath.org/terms)
   before applying. For this project that means:
   - MFA on the GitHub and SignPath accounts of everyone who commits or approves.
   - A **code signing policy** section on the project's home page and download page.
     A draft is below.
   - A **privacy policy** that names what the app sends. FogOfWar uploads each
     finished `.brp`, and reports each run as a job with its install ID and the
     PC's RAM, CPU and Windows build. The terms also ask for a way to turn
     uploading off. The app has no such switch yet.
   - An **uninstaller**. The app has none yet. Its files live in
     `%LOCALAPPDATA%\FogOfWar`, and autostart is an HKCU Run key.
   - Product name and version in the exe's metadata. `winres` already writes them.
   - At least one published release (an unsigned one is fine).
2. **Apply** at [signpath.org](https://signpath.org) with the repository URL and
   the download page. They review applications by hand.
3. **Once accepted**, in the SignPath organization they create for the project:
   - Link the predefined trusted build system **GitHub.com** to the project.
   - Under Artifact Configurations, make the default configuration the contents
     of `.signpath/artifact-configuration.xml`.
   - Create an API token for a user with the *submitter* role on the release
     signing policy.
4. **In GitHub** (repo > Settings > Secrets and variables > Actions):
   - Secret `SIGNPATH_API_TOKEN`: the API token.
   - Variable `SIGNPATH_ORGANIZATION_ID`: the organization ID. **Signing turns on
     when this variable exists.**
   - Variable `SIGNPATH_PROJECT_SLUG`: only if it is not `FogOfWar`.
   - Variable `SIGNPATH_SIGNING_POLICY_SLUG`: only if it is not `release-signing`.

The workflow runs only on GitHub-hosted runners and never re-runs a job
itself, so it already fits the build policies SignPath Foundation applies:
GitHub-hosted runners, and no signing of re-runs. **Don't re-run a failed
signing job**; start a new run instead.

## Code signing policy (draft for the download page)

> **Code signing policy**
>
> Free code signing provided by [SignPath.io](https://about.signpath.io),
> certificate by [SignPath Foundation](https://signpath.org).
>
> Committers and reviewers: [mabn](https://github.com/mabn)
> Approvers: [mabn](https://github.com/mabn)
>
> Every signed release is built by GitHub Actions from this repository's
> source and approved by hand before it is signed.
>
> **Privacy:** FogOfWar uploads each replay it re-simulates to
> replay.fogofwar.dev, and reports each run (its progress, timings, an install
> ID made on first launch, and the PC's RAM, CPU model and Windows version) so
> the site's queue can show it. It sends no other information.
