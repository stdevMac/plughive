---
name: share
description: Turn a library artifact into a public download link that expires, through the user's Cloudflare R2 or AWS S3 bucket (share_artifact, share_unshare). Use when the user wants to send someone an image, video or file from the library.
---

# Share links

## Tools

- `share_artifact`: uploads the artifact to the bucket and returns `url`, a presigned link valid for `expires_in_s` (default 1 hour). The pack's `maxExpirySeconds` setting caps it (default 1 day, never over 7 days).
- `share_unshare`: deletes the uploaded copy so every link to it stops working.

Anyone holding the link can download the file until it expires. Confirm with the user before sharing anything private, and prefer short lifetimes.

## Setup

Settings `endpoint` (R2: `https://<account id>.r2.cloudflarestorage.com`) and `bucket`, plus the secrets `SHARE_S3_ACCESS_KEY_ID` and `SHARE_S3_SECRET_ACCESS_KEY` (an R2 API token with write access to that bucket). If a call fails with `MISSING_SECRET`, tell the user which secret to set. A link contains the access key ID, as every S3 presigned link does, but never the secret key.
