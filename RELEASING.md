# Releasing

A release is a tag. Pushing `vX.Y.Z` runs
[.github/workflows/release.yml](.github/workflows/release.yml), which:

1. checks that the tag matches `version` in `package.json`, then typechecks,
   tests, builds, smoke-tests and checks the npm package contents;
2. publishes `plughive@X.Y.Z` to npm with provenance (`latest` tag, or `next`
   for a pre-release such as `1.2.0-rc.1`);
3. builds the Docker image on native amd64 and arm64 runners and pushes
   `ghcr.io/stdevmac/plughive:X.Y.Z` and `stdevmac/plughive:X.Y.Z` on
   Docker Hub, plus `:X.Y` and `:latest` for a stable release (Docker Hub only
   when the `DOCKERHUB_TOKEN` secret is set);
4. creates the GitHub Release with the `## X.Y.Z` section of `CHANGELOG.md` as
   its notes.

Re-running a failed release is safe: an npm version that is already published
is skipped, and an existing GitHub Release is updated.

## Cut a release

```sh
# 1. In CHANGELOG.md, rename "## Unreleased" to "## X.Y.Z" (add a new empty
#    "## Unreleased" above it if you like).
# 2. Bump the version without npm creating a tag:
npm version X.Y.Z --no-git-tag-version
git commit -am "Release X.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Watch it under Actions → Release.

## One-time setup

**npm.** The package `plughive` is unscoped and is published by the
`marcosmaceo` account. The `@stdevmac` org exists; after the first publish,
give its `developers` team write access to the package if others publish too.

- First publish: either run `npm publish --access public` once from a clean
  checkout on your machine, or create a granular access token on npmjs.com
  (Access Tokens → Generate New Token → Granular, read and write on all
  packages, "bypass 2FA" on) and save it as the repository secret `NPM_TOKEN`
  in the `release` environment.
- Then switch to trusted publishing so no token is stored: on npmjs.com open
  the package → Settings → Trusted Publisher → GitHub Actions, and enter
  owner `stdevMac`, repository `plughive`, workflow `release.yml`, environment
  `release`. Delete the `NPM_TOKEN` secret and, under Publishing access,
  choose "Require two-factor authentication and disallow tokens".

**Docker Hub.** Images go to `stdevmac/plughive` (the first push creates it; check it is public). Create
a personal access token at https://app.docker.com/settings/personal-access-tokens
(Read & Write) and save it as the secret `DOCKERHUB_TOKEN` in the `release`
environment, not as a repository secret, so only the publishing jobs can read
it.

**GitHub.**

- Settings → Environments → `release` (created by the first run if missing):
  add yourself as a required reviewer if every publish should wait for your
  approval, and limit deployment to tags matching `v*`. Every job that
  publishes (npm, both Docker builds, the Docker manifest and the GitHub
  Release) runs in this environment, so with a reviewer set a release asks
  for approval three times: npm and the builds together, then the manifest,
  then the release.
- After the first image push: the `plughive` package (your profile →
  Packages) → Package settings → Change visibility → Public, so
  `docker pull` works without signing in.
