import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/layout/IconSidebar.tsx'), 'utf8');
const settingsSource = readFileSync(resolve(process.cwd(), 'src/components/modals/SettingsModal.tsx'), 'utf8');

describe('extension claim removal', () => {
  it('does not advertise a non-existent extension host through primary navigation or settings', () => {
    expect(sidebarSource).not.toContain("{ id: 'extensions'");
    expect(settingsSource).not.toContain("{ id: 'extensions'");
    expect(settingsSource).not.toContain("label: 'Extensions'");
    expect(settingsSource).not.toContain("status: 'running'");
    expect(settingsSource).not.toContain("status: 'paused'");
  });
});
