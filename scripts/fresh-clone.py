#!/usr/bin/env python3
"""Fresh clone from GitHub using token from uploaded file."""
import subprocess
import re
import os
import sys

# Read token from uploaded file
with open('/home/z/my-project/upload/mu toke.txt', 'r') as f:
    content = f.read()

# Extract token - line format is "github token    XXX"
match = re.search(r'github\s+token\s+(\S+)', content)
if not match:
    print('ERROR: could not extract token from file')
    print(f'File content (first 200 chars): {content[:200]}')
    sys.exit(1)
token = match.group(1)
print(f'Token extracted (len={len(token)}, first 15: {token[:15]}..., last 4: ...{token[-4:]})')

# Build URL with token (token is embedded as basic-auth password)
url = f'https://jorlinmorgan071-gif:{token}@github.com/jorlinmorgan071-gif/CODESIREN-IDE.git'
print(f'URL: https://jorlinmorgan071-gif:[REDACTED]@github.com/jorlinmorgan071-gif/CODESIREN-IDE.git')

# Remove partial clone if exists
target = '/home/z/my-project/extracted/code_siren'
if os.path.exists(target):
    print(f'Removing partial clone at {target}')
    subprocess.run(['rm', '-rf', target], check=True)

# Run git clone
print('Running git clone...')
result = subprocess.run(
    ['git', 'clone', url, 'code_siren'],
    cwd='/home/z/my-project/extracted',
    capture_output=True,
    text=True,
    timeout=300,
    env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
)
print(f'--- git clone stdout ---')
print(result.stdout[-3000:] if len(result.stdout) > 3000 else result.stdout)
print(f'--- git clone stderr ---')
print(result.stderr[-3000:] if len(result.stderr) > 3000 else result.stderr)
print(f'--- exit code: {result.returncode} ---')

if result.returncode == 0:
    print('\n=== SUCCESS — clone complete ===')
    print('Verifying HEAD:')
    head = subprocess.run(['git', 'log', '--oneline', '-3'], cwd=target, capture_output=True, text=True)
    print(head.stdout)
else:
    print('\n=== FAILURE — clone failed ===')
    sys.exit(1)
