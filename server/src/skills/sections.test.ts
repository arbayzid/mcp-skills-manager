import { describe, expect, it } from 'vitest';
import { splitSections } from './sections.ts';

describe('splitSections', () => {
  it('splits at every heading level and keeps the text before the first', () => {
    expect(splitSections('intro\n\n# One\n\nfirst\n\n### Deep ###\n\nsecond')).toEqual([
      { heading: '', text: 'intro' },
      { heading: 'One', text: 'first' },
      { heading: 'Deep', text: 'second' },
    ]);
  });

  it('does not split at a `#` line inside a fenced code block', () => {
    const sections = splitSections('# Shell\n\n```sh\n# a comment\necho hi\n```\n\nafter');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain('# a comment');
    expect(sections[0]?.text).toContain('after');
  });

  it('closes a fence only with the same mark at least as long', () => {
    const sections = splitSections('````md\n```\n# not a heading\n````\n# Real');
    expect(sections.map((s) => s.heading)).toEqual(['', 'Real']);
  });

  it('keeps an empty heading section and drops empty leading text', () => {
    expect(splitSections('\n\n# Only\n')).toEqual([{ heading: 'Only', text: '' }]);
    expect(splitSections('')).toEqual([]);
  });
});
