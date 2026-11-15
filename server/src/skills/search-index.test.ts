import type { Skill } from '@mcp-skills/shared';
import { describe, expect, it, vi } from 'vitest';
import type { SkillSearchOptions } from './search-index.ts';
import { BODY_PATH, SkillSearchIndex } from './search-index.ts';

function skill(overrides: Partial<Skill> & Pick<Skill, 'name'>): Skill {
  return {
    description: '',
    body: '',
    frontmatter: {},
    format: 'dir',
    global: true,
    readOnly: false,
    path: `${overrides.name}/SKILL.md`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    files: [],
    tags: [],
    ...overrides,
  };
}

const UI = skill({
  name: 'ui-kit',
  description: 'How to use the UI components.',
  body: '# UI kit\n\nStart with the layout guide.',
  files: [
    { path: 'controls/combobox.md', type: 'file', size: 100 },
    { path: 'forms.md', type: 'file', size: 100 },
    { path: 'logo.png', type: 'file', size: 100 },
    { path: 'huge.md', type: 'file', size: 10 * 1024 * 1024 },
    { path: 'controls', type: 'dir', size: 0 },
  ],
});
const GIT = skill({ name: 'git-flow', description: 'Branching and commit conventions.', tags: ['git'] });

const FILES: Record<string, { content: string; binary: boolean }> = {
  'ui-kit/controls/combobox.md': {
    content: '---\ndescription: x\n---\n# Combobox\n\nA searchable select.\n\n## Props\n\n`options`, `onSelect`.',
    binary: false,
  },
  'ui-kit/forms.md': { content: '# Forms\n\nBind fields with useAppForm.', binary: false },
  'ui-kit/logo.png': { content: 'iVBORw0KGgo=', binary: true },
};

/** An index over the given skills, reading files from {@link FILES}; `reads` records every read. */
function indexOver(getSkills: () => Skill[]) {
  const reads: string[] = [];
  const readFile = vi.fn(async (name: string, relPath: string) => {
    reads.push(`${name}/${relPath}`);
    const file = FILES[`${name}/${relPath}`];
    if (file === undefined) {
      throw new Error('missing');
    }
    return file;
  });
  return { index: new SkillSearchIndex({ getSkills, readFile }), reads };
}

const opts = (query: string, extra: Partial<SkillSearchOptions> = {}): SkillSearchOptions => ({
  query,
  tags: [],
  limit: 10,
  ...extra,
});

describe('SkillSearchIndex', () => {
  it('finds a skill by a word only its supporting file holds, and says where', async () => {
    const { index } = indexOver(() => [UI, GIT]);
    const hits = await index.search([UI, GIT], opts('searchable select props'));
    expect(hits.map((h) => h.skill.name)).toEqual(['ui-kit']);
    expect(hits[0]?.passages.map((p) => `${p.path} § ${p.heading}`)).toContain('controls/combobox.md § Combobox');
  });

  it('reads only text files under the size cap, never folders, binaries or huge files', async () => {
    const { index, reads } = indexOver(() => [UI]);
    expect(await index.search([UI], opts('iVBORw0KGgo'))).toEqual([]);
    expect(reads.sort()).toEqual(['ui-kit/controls/combobox.md', 'ui-kit/forms.md', 'ui-kit/logo.png']);
  });

  it('matches camelCase parts, prefixes and small typos', async () => {
    const { index } = indexOver(() => [UI, GIT]);
    for (const query of ['app form', 'useAppForm', 'combo', 'comobox', 'conventions']) {
      const hits = await index.search([UI, GIT], opts(query));
      expect(hits.length, query).toBeGreaterThan(0);
    }
    expect((await index.search([UI, GIT], opts('conventions')))[0]?.skill.name).toBe('git-flow');
  });

  it('still finds a mid-word literal of the body by substring', async () => {
    const body = skill({ name: 'grep', body: 'use ripgrep' });
    const { index } = indexOver(() => [body]);
    expect((await index.search([body], opts('pgrep'))).map((h) => h.skill.name)).toEqual(['grep']);
  });

  it('weights metadata above body text', async () => {
    const meta = skill({ name: 'deploy', description: 'Deploy the app.' });
    const mention = skill({ name: 'notes', body: 'Long notes. Sometimes we deploy on Fridays, rarely.' });
    const { index } = indexOver(() => [meta, mention]);
    expect((await index.search([mention, meta], opts('deploy'))).map((h) => h.skill.name)).toEqual(['deploy', 'notes']);
  });

  it('searches only the served skills, and applies the tag filter before ranking', async () => {
    const { index } = indexOver(() => [UI, GIT]);
    expect(await index.search([GIT], opts('combobox'))).toEqual([]);
    expect((await index.search([UI, GIT], opts('', { tags: ['GIT'] }))).map((h) => h.skill.name)).toEqual(['git-flow']);
  });

  it('lists every served skill unranked when there is no query', async () => {
    const { index, reads } = indexOver(() => [UI, GIT]);
    const hits = await index.search([GIT, UI], opts('  '));
    expect(hits.map((h) => h.skill.name)).toEqual(['git-flow', 'ui-kit']);
    expect(reads).toEqual([]);
  });

  it('re-indexes a skill the store replaced and forgets one it dropped', async () => {
    let skills = [UI, GIT];
    const { index } = indexOver(() => skills);
    expect(await index.search(skills, opts('rebase'))).toEqual([]);

    const edited = { ...GIT, body: '# Rebasing\n\nRebase before merging.' };
    skills = [UI, edited];
    expect((await index.search(skills, opts('rebase'))).map((h) => h.skill.name)).toEqual(['git-flow']);

    skills = [UI];
    expect(await index.searchPassages(edited, 'rebase', 5)).toEqual([]);
  });

  it('reads each file once while the skill is unchanged', async () => {
    const { index, reads } = indexOver(() => [UI]);
    await Promise.all([index.search([UI], opts('combobox')), index.search([UI], opts('forms'))]);
    await index.search([UI], opts('props'));
    expect(reads.filter((r) => r === 'ui-kit/forms.md')).toHaveLength(1);
  });

  it('ranks one skill’s sections with a snippet around the match', async () => {
    const { index } = indexOver(() => [UI]);
    const passages = await index.searchPassages(UI, 'onSelect', 5);
    expect(passages[0]).toMatchObject({ path: 'controls/combobox.md', heading: 'Props' });
    expect(passages[0]?.snippet).toContain('onSelect');
    const body = await index.searchPassages(UI, 'layout guide', 5);
    expect(body[0]?.path).toBe(BODY_PATH);
  });

  it('ignores a query of nothing but stop words in ranking', async () => {
    const { index } = indexOver(() => [UI]);
    expect(await index.searchPassages(UI, 'the and of', 5)).toEqual([]);
  });
});
