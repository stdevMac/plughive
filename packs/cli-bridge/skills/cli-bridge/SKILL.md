---
name: cli-bridge
description: Ask the agent CLIs installed on this computer (claude, codex, gemini, agy, opencode, copilot) a question, or have Antigravity (agy) generate an image, with the accounts the user signed in to them. Use when the user wants a second opinion from another agent, wants to use their CLI subscription instead of an API key, or asks for an image made by agy.
---

# Agent CLIs (cli-bridge)

1. Call `list_agent_clis` first. Use only CLIs with `installed: true`. `logged_in` is
   what the CLI itself reports (claude and codex); `null` means unknown, not signed out.
2. `ask_agent_cli({cli, prompt})` runs one non-interactive turn and returns
   `{text, usage?, session_id?, model?}`. It is a background job: poll the job if the
   call returns one.
   - Without `cwd` the CLI runs in an empty scratch folder, which suits questions.
   - With `cwd` (an absolute path) the CLI works in that folder with its own tools. The
     folder must be inside one the user listed in the pack's `allowedFolders` setting;
     otherwise the call is refused. Do not ask the user to widen that list for you.
     The CLI's own trust checks apply there: gemini fails in a folder the user has not
     trusted in gemini, codex fails outside a git repository. Report that; do not retry
     without cwd as a workaround.
   - `model` is the CLI's own model name (letters, digits and . _ : / - only); omit it
     unless the user named one.
   - Write the whole task into `prompt`: each call is a fresh session.
3. `generate_image_via_agy({prompt})` saves agy's image to the artifact library and
   returns its artifact. If agy saves nothing, the error quotes what agy answered.

Each call uses the user's own subscription quota and the vendor's terms apply. Errors
such as "not signed in" or an expired key come from the CLI: tell the user to sign in
with that CLI in a terminal; never look for or read its credential files.
