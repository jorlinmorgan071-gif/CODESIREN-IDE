
---
Task ID: github-credential-permanence-v2
Agent: main (super-z)
Task: Make GitHub credential setup permanent in the sandbox after discovering that .gitconfig gets overwritten and .git-credentials gets deleted on every reset.

Work Log:
- Previous credential helper setup (device 44) was wiped by sandbox reset:
  - /home/z/.gitconfig was OVERWRITTEN by base image version (no [credential] section)
  - /home/z/.git-credentials was DELETED (not in base image)
  - /home/z/my-project/.env and worklog.md SURVIVED (not touched by base image)
- Key finding: files at /home/z/my-project/ root level survive resets because
  the base image doesn't touch them. Files at /home/z/ get reset to base image state.
- Solution: 
  1. Stored token at /home/z/my-project/.github-token (persistent, device 44)
  2. Created bootstrap script at /home/z/my-project/setup-git.sh (persistent, device 44)
  3. Script reads token from persistent file, writes .git-credentials + sets credential.helper
  4. After any reset, run: bash /home/z/my-project/setup-git.sh
- This is NOT fully automatic (no startup hook exists in this sandbox), but it
  reduces recovery from a full chat round-trip to a single command.
- Token upload file deleted (no longer needed — token is in persistent storage).

Stage Summary:
- Persistent files (survive resets, device 44):
  /home/z/my-project/.github-token  — the GitHub PAT
  /home/z/my-project/setup-git.sh   — bootstrap script
  /home/z/my-project/.env           — project env vars
  /home/z/my-project/worklog.md     — this worklog
- After a reset: run `bash /home/z/my-project/setup-git.sh` then re-clone.
- CHIMERA commit (ea9efa1) pushed to GitHub successfully using credential helper.
