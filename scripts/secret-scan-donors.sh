#!/usr/bin/env bash
# Tier 1 secret scan — CodeReviewAgent patterns
set -euo pipefail

cd /home/z/my-project/extracted/code_siren

PATTERNS=(
  # AWS
  '-e' 'AKIA[0-9A-Z]{16}'
  '-e' 'aws_secret_access_key'
  '-e' 'aws_access_key_id'
  # GitHub
  '-e' 'ghp_[A-Za-z0-9]{36}'
  '-e' 'github_pat_[A-Za-z0-9_]{40,}'
  # Google
  '-e' 'AIza[0-9A-Za-z_-]{35}'
  '-e' 'ya29\.[0-9A-Za-z_-]+'
  # Slack
  '-e' 'xox[baprs]-[0-9A-Za-z-]+'
  # OpenAI / Anthropic
  '-e' 'sk-[A-Za-z0-9]{20,}'
  '-e' 'sk-ant-[A-Za-z0-9_-]+'
  # Stripe / Twilio / SendGrid
  '-e' 'sk_live_[A-Za-z0-9]{20,}'
  '-e' 'SK[A-Fa-f0-9]{32}'  # Twilio
  '-e' 'SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}'  # SendGrid
  # Private keys
  '-e' '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'
  # JWT secrets / generic high-entropy
  '-e' 'jwt_secret'
  '-e' 'JWT_SECRET'
  # Generic assignments
  '-e' '(password|passwd|pwd|secret|api_key|apikey|access_token|auth_token)\s*[:=]\s*["'\''][^"'\'' ]{8,}'
  # Bearer tokens
  '-e' 'Bearer\s+[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
)

echo "=== Scanning extracted/ada_v2/ on origin/main ==="
git grep -n -i "${PATTERNS[@]}" origin/main -- 'extracted/ada_v2/*' 2>&1 | head -80 || echo "(no matches)"

echo ""
echo "=== Scanning extracted/openjarvis/ on origin/main ==="
git grep -n -i "${PATTERNS[@]}" origin/main -- 'extracted/openjarvis/*' 2>&1 | head -200 || echo "(no matches)"
