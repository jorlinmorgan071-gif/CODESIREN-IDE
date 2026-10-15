import json, sys

with open('/tmp/gitleaks-full.json') as f:
    data = json.load(f)

print(f'Total findings: {len(data)}')
print()
for i, finding in enumerate(data, 1):
    sep = '=' * 70
    print(sep)
    print(f'FINDING #{i}')
    print(sep)
    print(f'  RuleID:      {finding.get("RuleID","?")}')
    print(f'  File:        {finding.get("File","?")}')
    print(f'  Line:        {finding.get("StartLine","?")}-{finding.get("EndLine","?")}')
    print(f'  Commit:      {finding.get("Commit","?")}')
    print(f'  Author:      {finding.get("Author","?")}')
    print(f'  Email:       {finding.get("Email","?")}')
    print(f'  Date:        {finding.get("Date","?")}')
    print(f'  Secret:      {finding.get("Secret","?")}')
    print(f'  Entropy:     {finding.get("Entropy","?")}')
    print(f'  Fingerprint: {finding.get("Fingerprint","?")}')
    match = finding.get("Match","?")
    if len(match) > 200:
        match = match[:200] + '...(truncated by script, see full output below)'
    print(f'  Match:       {match}')
    print()
